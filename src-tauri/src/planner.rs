// Running the studio's pipeline Python on THIS machine.
//
// THE POD WAS MANDATORY FOR PLANNING, and that made "use the app with only a
// local engine" untrue for the first thing anyone does. `plan_storyboard` is
// ~3,000 lines of `storyplan.py` plus its orchestration — far too rule-dense
// to reimplement in TypeScript without creating the worst twin in this repo.
// It does not need reimplementing: `storyplan.py` imports `json`, `math` and
// `re`, `llm.py` needs no `media` and no boto3, and `install_engine` has
// already put a private CPython on disk for ComfyUI. So the same source runs
// here, unchanged.
//
// WHY RUST RUNS IT rather than the webview shelling out: this is the process
// that can read the keychain. The provider key goes straight from the keychain
// into the CHILD'S ENVIRONMENT and never enters the webview — the same
// guarantee `secrets.rs` makes for every other BYOK path, kept for this one by
// not routing the key through JavaScript at all.
//
// THE SERVICE KEY IS NEVER INVOLVED. `sb.py` is started session-scoped: the
// anon key as `apikey` and the signed-in user's access token as the bearer, so
// RLS scopes every read and write the planner makes. Shipping a service key in
// a desktop app would put a bypass-RLS credential for every account on every
// installer.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Which provider keys the planner is given, and under which name.
///
/// `llm._key` reads `os.environ` first, so a key placed here needs no change
/// anywhere in the Python. Only the three that can drive a pipeline turn — a
/// fal key spends nothing here and would be an exposure with no purpose.
/// What the child is told about the LOCAL SPEECH ENGINES.
///
/// ONE FUNCTION FOR BOTH, because what it decides is not "is Breeze up" but
/// "which engines exist here" — and `dialogue_synth.resolve_provider` reads
/// the answer per engine. Told about only one, a plan the wizard cast on the
/// other finds its server unreachable and falls back with a log line: the pick
/// defeated, on a machine where the engine was installed and running.
///
/// Pure, and takes both healths as arguments, so every combination is a test
/// rather than two services. See the call site for why the units are always
/// cleared.
pub(crate) fn speech_env(breeze_up: bool, qwen_up: bool) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = vec![
        ("BREEZE_UNIT", String::new()),
        ("QWEN_UNIT", String::new()),
    ];
    if breeze_up {
        out.push(("BREEZE_TTS_URL", crate::breeze::base_url()));
    }
    if qwen_up {
        out.push(("QWEN_TTS_URL", crate::qwen::base_url()));
    }
    // THE DEFAULT, not an override: `payload.dialogue_provider` still wins in
    // `resolve_provider`, so a plan that asked for ElevenLabs — or for the
    // other local engine — still gets what it asked for. It exists only for a
    // plan that named nothing, and BREEZE LEADS because it is the wizard's own
    // default and the engine that can direct a line; naming Qwen here would
    // quietly re-cast every unspecified plan on a machine that has both.
    if breeze_up {
        out.push(("DIALOGUE_PROVIDER", "breeze".into()));
    } else if qwen_up {
        out.push(("DIALOGUE_PROVIDER", "qwen".into()));
    }
    out
}

const PLANNER_KEYS: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("google", "GEMINI_API_KEY"),
    // Speech. `dialogue_synth` measures every line at PLAN time — that is what
    // replaced the words-per-second guess behind DIALOGUE_CUTOFF — and
    // `handlers/tts` is a job kind the desktop now claims outright. Without
    // the key both fall back silently: the plan keeps the heuristic floor and
    // the job renders in a stock OpenAI voice.
    ("elevenlabs", "ELEVENLABS_API_KEY"),
    ("fish", "FISH_API_KEY"),
];

#[derive(Serialize)]
pub struct PlanOutcome {
    pub ok: bool,
    /// the planner's own sentence when it failed, already run through
    /// `llm.explain_error` so the desktop and the pod say the same thing
    pub error: Option<String>,
    /// the tail of stderr, for a failure the JSON channel never reached
    pub log: String,
}

/// Where the pipeline source lives once the app is installed.
///
/// A BUNDLED RESOURCE, not a download: the planner has to match the app that
/// is driving it. The pod gets its copy from a B2 tarball because it is
/// redeployed independently; a desktop build has no such gap to bridge, and a
/// version skew here would be a storyboard written by one release and read by
/// another.
pub(crate) fn worker_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("worker", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("the pipeline source is not in this build: {e}"))
}

/// The DESKTOP tier of model_map, and the workflow templates it names.
///
/// GENERATED FROM THE POD'S (`scripts/gen_desktop_model_map.mjs`) and bundled
/// beside the pipeline, so `resolve.py` — unchanged — parameterises the same
/// templates against files the engine window can actually download. Absent,
/// nothing that drives ComfyUI is offered: `plan_cli` refuses those kinds by
/// name rather than resolving a graph against the pod's filenames.
fn model_map(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path()
        .resolve("infra/model_map.desktop.json", tauri::path::BaseDirectory::Resource)
        .ok()?;
    p.exists().then_some(p)
}

fn workflows_dir(app: &AppHandle) -> Option<PathBuf> {
    let p = app.path()
        .resolve("workflows", tauri::path::BaseDirectory::Resource)
        .ok()?;
    p.is_dir().then_some(p)
}

/// True when this machine could run a plan right now — the engine's Python is
/// on disk and the pipeline source is bundled.
///
/// Asked BEFORE a job is queued, so the wizard can route it to the pod instead
/// of writing a row nothing will ever claim.
#[tauri::command]
pub fn planner_ready(app: AppHandle) -> bool {
    let py = crate::engine::python_bin(&crate::engine::engine_root(&app));
    py.exists() && worker_dir(&app).map(|d| d.join("plan_cli.py").exists()).unwrap_or(false)
}

/// Which model_map keys this build could render with, and which of them have
/// every file on disk right now.
///
/// Asked BEFORE an episode is queued, because the two answers are different
/// and both matter: a key this build does not carry can never render here, and
/// one whose 57GB of weights are not downloaded yet is a job that would fail
/// on its first resolve. The wizard says so rather than planning an episode
/// whose every block dies on being claimed.
#[derive(Serialize)]
pub struct DesktopRenderModel {
    pub key: String,
    /// which section of the map it came from: "video" (`models`) or "image"
    /// (`image_models`).
    ///
    /// IT IS NOT DECORATION. The two sections are separate id spaces and they
    /// COLLIDE: `minimax-h3` is a video entry and `h3-image` an image one, and
    /// nothing stops a future pair sharing a name outright. A caller asking
    /// "can this machine render my image model" against an unkinded list would
    /// happily match a video row and report a block renderer as a still one.
    pub kind: String,
    pub modes: Vec<String>,
    /// every weight file the entry names is present under COMFY_ROOT
    pub ready: bool,
    /// what is not, so the engine window can be pointed at it
    pub missing: Vec<String>,
    /// The precision rung this machine would actually render on, when it is
    /// NOT the one the map declares.
    ///
    /// SAID RATHER THAN SILENT. `apply_rungs` lets a laptop holding Klein 4B
    /// at Q4_K_M satisfy an entry naming the fp8 — which is the whole point —
    /// but a row that reads "on this machine" while rendering on weights the
    /// map does not name is the substitution this codebase treats as a bug
    /// everywhere else. `None` means the declared rung.
    pub rung: Option<String>,
}

/// Point each entry at the precision rung this machine has, and say which.
///
/// THE TWIN OF `resolve.apply_rungs`, and it has to be: this decides what the
/// picker calls ready and that one decides what the render loads. Two answers
/// would be a row that offers a model the job then fails to resolve. Both walk
/// the generator's `_rungs` in the same order — best first, declared always
/// winning when it is present — so they cannot disagree unless the disk
/// changes between the two calls.
///
/// Inert on a map without `_rungs`, which is every map but the generated one.
fn apply_rungs(v: &mut serde_json::Value, present: &impl Fn(&str) -> bool) -> Vec<(String, String)> {
    let mut chosen = Vec::new();
    let Some(tier) = v.pointer_mut("/desktop").and_then(|t| t.as_object_mut()) else {
        return chosen;
    };
    for section in tier.values_mut() {
        let Some(entries) = section.as_object_mut() else { continue };
        for (key, entry) in entries.iter_mut() {
            let Some(alts) = entry.get("_rungs").cloned() else { continue };
            if let Some(obj) = entry.as_object_mut() { obj.remove("_rungs"); }
            let Some(alts) = alts.as_array() else { continue };
            let mut declared: Vec<String> = Vec::new();
            for a in alts {
                if let Some(m) = a.pointer("/swap").and_then(|m| m.as_object()) {
                    for k in m.keys() {
                        if !declared.contains(k) { declared.push(k.clone()) }
                    }
                }
            }
            if declared.iter().all(|f| present(f)) { continue }
            for a in alts {
                let (Some(id), Some(swap)) = (
                    a.pointer("/id").and_then(|x| x.as_str()),
                    a.pointer("/swap").and_then(|m| m.as_object()),
                ) else { continue };
                // A file this rung does not rename it SHARES with the declared
                // one — the generator drops identity mappings — so it has to be
                // on disk too.
                let ok = swap.values().filter_map(|x| x.as_str()).all(present)
                    && declared.iter().all(|f| swap.contains_key(f) || present(f));
                if !ok { continue }
                let table: Vec<(String, String)> = swap.iter()
                    .filter_map(|(k, x)| x.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect();
                rename_files(entry, &table);
                chosen.push((key.clone(), id.to_string()));
                break;
            }
        }
    }
    chosen
}

/// Rewrite every weight filename in an entry, at any depth.
fn rename_files(v: &mut serde_json::Value, swap: &[(String, String)]) {
    match v {
        serde_json::Value::String(s) => {
            if let Some((_, to)) = swap.iter().find(|(from, _)| from == s) {
                *s = to.clone();
            }
        }
        serde_json::Value::Array(a) => for x in a { rename_files(x, swap) },
        serde_json::Value::Object(o) => for (_, x) in o { rename_files(x, swap) },
        _ => {}
    }
}

#[tauri::command]
pub fn desktop_render_models(app: AppHandle) -> Vec<DesktopRenderModel> {
    let Some(map) = model_map(&app) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&map) else { return Vec::new() };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
    // `comfy_home`, not our own tree: a machine rendering through a LINKED
    // ComfyUI holds its weights in that tree, and checking ours would report
    // every one of them missing — the wizard would then say the pod is still
    // needed for a block this machine can render.
    let comfy = crate::engine::comfy_home(&app).join("models");
    // BEFORE the weight walk, so `ready` is judged against the files this
    // machine would actually load. The rung check does not know a file's
    // shelf, so it asks every one this app writes to — the same allowance
    // `present` already makes between `diffusion_models` and `unet`.
    let anywhere = |f: &str| DIRS.iter().any(|d| present(&comfy, d, f));
    let chosen: std::collections::HashMap<String, String> =
        apply_rungs(&mut v, &anywhere).into_iter().collect();
    let mut out = render_models_from(&v, |dir, fname| present(&comfy, dir, fname));
    for m in &mut out { m.rung = chosen.get(&m.key).cloned() }
    out
}

/// Every shelf a weight file can sit on, for the rung check — which is handed a
/// bare filename out of a swap table and has no key to infer a directory from.
const DIRS: [&str; 8] = ["diffusion_models", "unet", "text_encoders", "vae",
                         "checkpoints", "loras", "latent_upscale_models", "vae_approx"];

/// The map's two model tables, read as one list.
///
/// BOTH SECTIONS, because `plan_cli.KINDS` carries `image_gen` as well as
/// `master_pass`: a reference sheet resolves against `image_models` through
/// the very same `resolve.py`, so "can this machine render it" is one question
/// asked of two tables. An absent section is not an error — the generator
/// drops an entry whose files the engine window cannot fetch, so a map with no
/// image models left in it is a real state.
///
/// Split off the command so it can be tested: everything above needs an
/// `AppHandle`, and the part worth pinning is which section a row is filed
/// under.
fn render_models_from(
    v: &serde_json::Value, present: impl Fn(&str, &str) -> bool,
) -> Vec<DesktopRenderModel> {
    let sections = [("video", "/desktop/models"), ("image", "/desktop/image_models")];
    let mut out = Vec::new();
    for (kind, ptr) in sections {
        let Some(serde_json::Value::Object(models)) = v.pointer(ptr) else { continue };
        for (key, entry) in models {
            let mut modes: Vec<String> = entry.pointer("/modes")
                .and_then(|m| m.as_object())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            modes.sort();
            // The same rule the generator applies: every weight-looking string
            // the entry names, at any depth, minus the optional adapter table
            // — plus whatever `from_model` inherits, which is most of it for
            // the entries that use one.
            let want = entry_weights(v, entry, 0);
            let missing: Vec<String> = want.iter()
                .filter(|(dir, fname)| !present(dir, fname))
                .map(|(_, f)| f.clone())
                .collect();
            out.push(DesktopRenderModel {
                key: key.clone(), kind: kind.to_string(), modes, rung: None,
                // NOTHING FOUND IS NOT NOTHING MISSING. An entry naming no
                // weight file at all cannot be judged, and calling it ready
                // is the check passing VACUOUSLY — which is exactly how
                // SenseNova (a transformers checkpoint at an absolute POD
                // path, outside ComfyUI's model tree) came to be offered
                // under "on this machine" on a laptop that had none of it.
                // `gen_desktop_model_map.mjs` drops such an entry at the
                // source now; this is the backstop, because the map ships
                // with the build and a future entry could reintroduce it.
                ready: !want.is_empty() && missing.is_empty(),
                missing,
            });
        }
    }
    // Sorted by (kind, key) so the list is stable across runs — the two
    // sections are read from a map whose key order serde does not promise.
    out.sort_by(|a, b| (&a.kind, &a.key).cmp(&(&b.kind, &b.key)));
    out
}

/// Every weight an entry needs, INCLUDING what `from_model` inherits.
///
/// `h3-image` is `minimax-h3` plus a one-frame decoder: its own keys name the
/// 5GB image VAE and nothing else, so judged alone it reports READY while the
/// 32GB of H3 checkpoints it renders on are still missing — the wizard would
/// then plan an episode's sheets onto this machine and every one of them would
/// die on its first resolve.
///
/// The parent is looked up in BOTH sections because a cross-section reference
/// is exactly what `from_model` is for (an image entry naming a video one),
/// and `depth` bounds a chain that a hand-edited map could make circular.
fn entry_weights(
    map: &serde_json::Value, entry: &serde_json::Value, depth: usize,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    collect_weights(entry, None, &mut out);
    if depth >= 4 { return out }
    if let Some(parent_key) = entry.get("from_model").and_then(|v| v.as_str()) {
        for ptr in ["/desktop/models", "/desktop/image_models"] {
            if let Some(p) = map.pointer(ptr).and_then(|m| m.get(parent_key)) {
                out.extend(entry_weights(map, p, depth + 1));
                break;
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Is this weight on disk?
///
/// `models/unet` is checked as well as `models/diffusion_models`, and only for
/// those: ComfyUI itself treats the two as ONE folder key (`diffusion_models`
/// lists both, and city96's GGUF loader registers both), so a LINKED ComfyUI
/// may legitimately file a checkpoint under either. Our own engine writes to
/// `diffusion_models`; someone else's tree is not ours to have an opinion
/// about, and reporting their model missing would send them to the cloud for a
/// render they can already do.
fn present(comfy: &Path, dir: &str, fname: &str) -> bool {
    let hit = |d: &str| {
        let p = comfy.join(d).join(fname);
        p.exists() || p.is_symlink()
    };
    hit(dir) || (dir == "diffusion_models" && hit("unet"))
}

/// (subdir, filename) for every weight file a model_map entry names.
///
/// The SUBDIR is decided by which key held the string, because that is what
/// ComfyUI's own loaders use: `vae`/`audio_vae` land in `models/vae`,
/// `text_encoders` in `models/text_encoders`, a checkpoint in
/// `diffusion_models`. Guessing one directory for all of them would report a
/// present file as missing.
fn collect_weights(v: &serde_json::Value, key: Option<&str>, out: &mut Vec<(String, String)>) {
    match v {
        serde_json::Value::String(s) => {
            let lower = s.to_ascii_lowercase();
            if [".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin"]
                .iter().any(|e| lower.ends_with(e))
            {
                let dir = match key {
                    Some("vae") | Some("audio_vae") | Some("image_vae") => "vae",
                    Some(k) if k.contains("text_encoder") => "text_encoders",
                    Some("latent_upscaler") => "latent_upscale_models",
                    // H3's PDD acceleration. The `pdd` block names its two
                    // files by TRUNK (`fl2va` for t2v/i2v/flf, `ref2va` for the
                    // reference mode an episode renders in), and they live in
                    // the folder the PDD pack registers for itself — not in
                    // `loras`, which is where the `contains("lora")` arm below
                    // would otherwise put them, and not in `diffusion_models`,
                    // which is where the fallthrough would.
                    //
                    // Matched on the LEAF key because that is all this function
                    // carries; those two names are the PDD block's own
                    // vocabulary and appear as a key nowhere else in either
                    // map. Wrong, this reports a downloaded PDD as permanently
                    // missing and the wizard sends an episode to the cloud that
                    // this machine can render — the `latent_upscale_models`
                    // trap, one directory over.
                    Some("fl2va") | Some("ref2va") => "pdd_acc",
                    Some(k) if k.contains("lora") => "loras",
                    // A GGUF LANDS IN `diffusion_models` HERE, not in `unet`.
                    // That is the pod's convention (`resolve.ensure_model` maps
                    // a `gguf` entry to `models/unet`) and it is wrong for this
                    // tree: `engineCatalog`'s `gguf()` helper writes every one
                    // of them to `models/diffusion_models`, which is also the
                    // only place `engine_status` scans — there is no `unet` in
                    // `MODEL_DIRS` at all. Left as `unet`, every quantised
                    // entry reported EVERY file missing however complete the
                    // download was, and the wizard would send someone to the
                    // cloud for a block this machine can render. Latent until
                    // the desktop grew quantised H3 entries, because until then
                    // no `/desktop/models` entry named a `.gguf`.
                    _ => "diffusion_models",
                };
                out.push((dir.into(), s.clone()));
            }
        }
        serde_json::Value::Array(a) => for x in a { collect_weights(x, key, out) },
        serde_json::Value::Object(o) => for (k, x) in o {
            // Optional picks: an entry is not unrenderable for lacking one, and
            // the generator has already pruned them to what is gettable.
            if k == "style_loras" { continue; }
            collect_weights(x, Some(k), out);
        },
        _ => {}
    }
}

/// Run one pipeline task to completion.
///
/// `providers` is the ids whose keys this plan may spend — the BACKEND the
/// user picked, not every key on the machine. Reaching for a key nobody chose
/// is the same silent spend `routeHere` refuses.
///
/// `local_project` is the project this job belongs to WHEN IT LIVES ON THIS
/// MACHINE. Its rows are a file the webview owns, so `SUPABASE_URL` is
/// repointed at the loopback proxy and `sb.py` — unchanged — talks to the app
/// instead of Supabase. Its media folder comes with it — derived here from
/// `localstore`, so the path shape has one owner — and `QAMBA_MEDIA_ROOT`
/// turns every `media.b2_put`/`b2_get` into a file operation under it. Absent
/// is a cloud project, which reaches Supabase and B2 exactly as the pod does.
///
/// `api_base` and `cdn_base` are where media goes and comes from. A CLOUD
/// project rendered here has no B2 app key — there must never be one on a
/// laptop, it is a write credential for every account's media — so `media.py`
/// presigns through the studio's own `/api/upload-url` with the session,
/// exactly as the browser does, and reads through the same CDN `mediaUrl()`
/// uses. A LOCAL project needs neither: its media is a folder.
///
/// THE CHILD IS WAITED ON A BLOCKING THREAD, and that is not a detail. For a
/// local project this process must keep answering the proxy WHILE the child
/// runs — the answers come from the webview, over a Tauri command, which is
/// dispatched on the same async runtime. Blocking a runtime worker on
/// `wait_with_output` here is how a job would deadlock against the very
/// queries it is waiting for.
///
/// Cancellation is the job row's own `cancel_requested`, which the Python
/// already polls; killing the child instead would leave the storyboard
/// half-written.
#[tauri::command]
pub async fn plan_run(
    app: AppHandle,
    job: String,
    providers: Vec<String>,
    ollama_url: Option<String>,
    local_project: String,
) -> Result<PlanOutcome, String> {
    // Asked ONCE, here, rather than per env var: it is a 4s-timeout HTTP call
    // and the answer decides two variables that must agree with each other.
    let breeze_up = crate::breeze::is_serving().await;
    // ASKED SEPARATELY, because they install, start and fail separately — a
    // machine routinely has one and not the other, and the plan's cast depends
    // on which the child is told about.
    let qwen_up = crate::qwen::is_serving().await;
    let root = crate::engine::engine_root(&app);
    let py = crate::engine::python_bin(&root);
    if !py.exists() {
        return Err("the local engine's Python is not installed — install the engine first".into());
    }
    let dir = worker_dir(&app)?;
    let cli = dir.join("plan_cli.py");
    if !cli.exists() {
        return Err("this build does not carry the pipeline source".into());
    }
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    // THE PROJECT IS SERVED TO THE CHILD OVER LOOPBACK by the app itself, so
    // `sb.py` needs no change at all: it speaks PostgREST either way, and the
    // per-run token goes in the ACCESS TOKEN slot because that is the header
    // it already sends as the bearer. Nothing here reaches a network.
    let (port, token) = crate::dbproxy::open_session(&app, local_project.clone()).await?;
    let session = Some((port, token.clone()));
    env.insert("SUPABASE_URL".into(), format!("http://127.0.0.1:{port}"));
    env.insert("SUPABASE_ANON_KEY".into(), "local".into());
    env.insert("SUPABASE_ACCESS_TOKEN".into(), token);
    {
        let dir = crate::localstore::media_root(&app, &local_project)?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not open the project's media folder: {e}"))?;
        env.insert("QAMBA_MEDIA_ROOT".into(), dir.to_string_lossy().into_owned());
    }
    // THE RENDER TIER. `resolve.py` reads every filename, template, frame grid
    // and sampler out of the map named here, so pointing it at the desktop one
    // is the whole of "this machine renders the same graphs the pod does".
    // COMFY_ROOT is what `ensure_model` checks presence against — get it wrong
    // and every model reads as missing, on a machine that has them all.
    if let (Some(map), Some(wf)) = (model_map(&app), workflows_dir(&app)) {
        env.insert("MODEL_TIER".into(), "desktop".into());
        env.insert("MODEL_MAP".into(), map.to_string_lossy().into_owned());
        env.insert("WORKFLOWS_DIR".into(), wf.to_string_lossy().into_owned());
        // `comfy_home`, for two reasons that both bite on a linked setup: it is
        // what `ensure_model` checks weight presence against, and it is where
        // staging copies a render's inputs — the process listening on :8188 is
        // the LINKED one, which reads ITS OWN input/ directory, so staging
        // into our (possibly empty) tree feeds the render nothing.
        env.insert("COMFY_ROOT".into(),
                   crate::engine::comfy_home(&app).to_string_lossy().into_owned());
    }
    // THE CHILD'S PATH, and this is a repair rather than an addition. A
    // macOS app launched from Finder inherits the launchd PATH — measured
    // EMPTY, i.e. the `/usr/bin:/bin:/usr/sbin:/sbin` fallback — so a machine
    // with a perfectly good Homebrew ffmpeg failed every render with "this
    // needs ffmpeg on your PATH", because `/opt/homebrew/bin` is added by
    // shell rc files that a GUI app never sources. `child_path` puts those
    // directories back and appends our own `bin/` last, so a system ffmpeg
    // stays in charge and ours is the fallback.
    env.insert("PATH".into(), crate::engine::child_path(&crate::engine::engine_root(&app)));
    // THE LOCAL SPEECH ENGINES, each when it is actually answering.
    //
    // Asked rather than assumed: `dialogue_synth.provider_default()` picks
    // Breeze whenever `BREEZE_TTS_URL` is set, and a plan that casts every
    // character a Breeze voice against a service that is not running fails at
    // the FIRST line — after the writer, the editor and the cinematographer
    // have all run. Unset, the same function falls to ElevenLabs on the user's
    // own key, or `resolve_provider` reports that neither engine is there.
    //
    // `BREEZE_UNIT`/`QWEN_UNIT` are ALWAYS cleared, health or no health: the
    // empty string is
    // how the Python knows there is no systemd here, so it neither shells out
    // to `sudo -n systemctl` nor reports "the unit would not start" on a
    // machine that has no units. The service is a child of this app, and
    // `breeze_ensure_up` is what brings it back.
    for (k, v) in speech_env(breeze_up, qwen_up) {
        env.insert(k.into(), v);
    }
    // `sb.py` prefers the session pair, but an inherited SUPABASE_SERVICE_KEY
    // from a developer's own shell would silently win and send the plan's
    // reads and writes somewhere else entirely. Cleared rather than trusted.
    env.insert("SUPABASE_SERVICE_KEY".into(), String::new());
    if let Some(u) = ollama_url.filter(|u| !u.is_empty()) {
        env.insert("OLLAMA_URL".into(), u);
    }
    for (provider, var) in PLANNER_KEYS {
        if providers.iter().any(|p| p == provider) {
            if let Ok(v) = crate::secrets::read_secret(provider) {
                env.insert((*var).into(), v);
            }
        }
    }

    let out = tauri::async_runtime::spawn_blocking(move || -> Result<std::process::Output, String> {
        let mut cmd = std::process::Command::new(&py);
        cmd.arg(&cli).arg("-")
            .current_dir(&dir)
            .envs(&env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = crate::hardware::no_window(&mut cmd)
            .spawn()
            .map_err(|e| format!("could not start the planner: {e}"))?;
        {
            use std::io::Write;
            let mut sin = child.stdin.take().ok_or("the planner took no input")?;
            sin.write_all(job.as_bytes()).map_err(|e| format!("could not send the job: {e}"))?;
        }
        child.wait_with_output().map_err(|e| format!("the planner did not finish: {e}"))
    })
    .await
    .map_err(|e| format!("the planner task did not finish: {e}"));

    // Closed however the run ends. A token left behind is a loopback port that
    // answers reads and writes for a project after the job that needed it has
    // gone.
    if let Some((_, token)) = &session {
        crate::dbproxy::close_session(&app, token);
    }
    let out = out??;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // The LAST json line: the planner logs to stderr, but a stray print from a
    // dependency on stdout would otherwise be parsed as the result.
    let parsed = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok());
    let tail: String = stderr.lines().rev().take(40).collect::<Vec<_>>()
        .into_iter().rev().collect::<Vec<_>>().join("\n");

    match parsed {
        Some(v) => Ok(PlanOutcome {
            ok: v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false),
            error: v.get("error").and_then(|e| e.as_str()).map(str::to_string),
            log: tail,
        }),
        // No JSON at all means the process died before `main` could report —
        // a segfault, an OOM kill, a missing interpreter. The exit code and
        // the log are all there is, and both are more use than "failed".
        None => Ok(PlanOutcome {
            ok: false,
            error: Some(format!(
                "the planner exited with {} and said nothing",
                out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "no code".into()))),
            log: tail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map with one entry declaring fp8 and offering the Q4 rung.
    fn rung_map() -> serde_json::Value {
        serde_json::from_str(r#"{"desktop": {
          "image_models": {
            "klein": {
              "family": "flux2",
              "unet": "declared-fp8.safetensors",
              "text_encoder": "shared-te.safetensors",
              "_rungs": [
                {"id": "q5", "swap": {"declared-fp8.safetensors": "rung-Q5.gguf"}},
                {"id": "q4", "swap": {"declared-fp8.safetensors": "rung-Q4.gguf"}}
              ]
            }
          }
        }}"#).unwrap()
    }

    fn on(have: &[&'static str]) -> impl Fn(&str) -> bool {
        let set: std::collections::HashSet<String> =
            have.iter().map(|s| s.to_string()).collect();
        move |f: &str| set.contains(f)
    }

    #[test]
    fn the_declared_rung_wins_whenever_it_is_on_disk() {
        // A machine holding BOTH renders on the one the map names. Preferring
        // the alternate would silently downgrade a correctly-provisioned
        // machine to whatever else it happens to have lying about.
        let mut v = rung_map();
        let got = apply_rungs(&mut v, &on(&["declared-fp8.safetensors", "rung-Q4.gguf"]));
        assert!(got.is_empty(), "declared rung present, so nothing to swap");
        assert_eq!(v.pointer("/desktop/image_models/klein/unet").unwrap(),
                   "declared-fp8.safetensors");
    }

    #[test]
    fn a_missing_declared_rung_falls_to_the_best_one_present() {
        // Q5 comes first in the table (quality order), so with only Q4 on disk
        // it must skip Q5 rather than stopping at the first entry.
        let mut v = rung_map();
        let got = apply_rungs(&mut v, &on(&["rung-Q4.gguf"]));
        assert_eq!(got, vec![("klein".to_string(), "q4".to_string())]);
        assert_eq!(v.pointer("/desktop/image_models/klein/unet").unwrap(), "rung-Q4.gguf");
    }

    #[test]
    fn no_rung_at_all_leaves_the_entry_naming_what_it_declared() {
        // …so `render_models_from` reports the DECLARED file as missing, which
        // is the name the engine window can actually be pointed at.
        let mut v = rung_map();
        assert!(apply_rungs(&mut v, &on(&[])).is_empty());
        assert_eq!(v.pointer("/desktop/image_models/klein/unet").unwrap(),
                   "declared-fp8.safetensors");
    }

    #[test]
    fn the_rung_table_is_stripped_so_it_never_reads_as_a_weight() {
        // `_rungs` is full of filenames. Left on the entry, `collect_weights`
        // would count every rung of every ladder as a REQUIRED file and no
        // entry would ever be ready again.
        let mut v = rung_map();
        apply_rungs(&mut v, &on(&["rung-Q4.gguf"]));
        assert!(v.pointer("/desktop/image_models/klein/_rungs").is_none());
        let rows = render_models_from(&v, |_, f| f == "rung-Q4.gguf" || f == "shared-te.safetensors");
        assert!(rows[0].ready, "missing: {:?}", rows[0].missing);
    }

    #[test]
    fn a_file_one_rung_keeps_and_another_replaces_must_still_be_present() {
        // H3'S REAL SHAPE. Its rungs each list their own text encoder, and the
        // quantised ones REUSE the int8 rung's — so the generator drops that
        // identity mapping from the GGUF swap while the studio swap still
        // renames it. Judged on swap targets alone, the quantised rung would
        // be accepted by a machine that has the checkpoint and not the
        // encoder, and the entry would be called ready with half its files.
        //
        // (A file no rung mentions at all — a shared VAE — is deliberately NOT
        // this function's business: `render_models_from` walks every weight
        // the entry names afterwards and reports it missing there.)
        let map = || serde_json::from_str::<serde_json::Value>(r#"{"desktop": {
          "models": {
            "h3": {
              "ckpt": "int8-fl2va.safetensors",
              "te": "nvfp4-te.safetensors",
              "_rungs": [
                {"id": "studio", "swap": {
                   "int8-fl2va.safetensors": "studio-fl2va.safetensors",
                   "nvfp4-te.safetensors": "studio-te.safetensors"}},
                {"id": "q4", "swap": {"int8-fl2va.safetensors": "h3-Q4.gguf"}}
              ]
            }
          }
        }}"#).unwrap();

        // The Q4 checkpoint is here and the encoder it SHARES with the declared
        // rung is not — so Q4 is refused rather than half-applied.
        let mut v = map();
        assert!(apply_rungs(&mut v, &on(&["h3-Q4.gguf"])).is_empty());
        assert_eq!(v.pointer("/desktop/models/h3/ckpt").unwrap(), "int8-fl2va.safetensors");

        // With the shared encoder present it is taken, and the encoder is left
        // exactly as it was.
        let mut v = map();
        assert_eq!(apply_rungs(&mut v, &on(&["h3-Q4.gguf", "nvfp4-te.safetensors"])),
                   vec![("h3".to_string(), "q4".to_string())]);
        assert_eq!(v.pointer("/desktop/models/h3/ckpt").unwrap(), "h3-Q4.gguf");
        assert_eq!(v.pointer("/desktop/models/h3/te").unwrap(), "nvfp4-te.safetensors");
    }

    #[test]
    fn a_map_with_no_rung_table_is_untouched() {
        // Which is every map but the generated one — the pod's included.
        let mut v: serde_json::Value = serde_json::from_str(
            r#"{"desktop": {"models": {"h3": {"unet": "a.safetensors"}}}}"#).unwrap();
        let before = v.clone();
        assert!(apply_rungs(&mut v, &on(&[])).is_empty());
        assert_eq!(v, before);
    }

    #[test]
    fn both_model_tables_are_read_and_each_row_says_which_it_came_from() {
        // THE TWO SECTIONS ARE SEPARATE ID SPACES AND THEY COLLIDE — here
        // deliberately, on `shared`. A caller asking "can this machine draw my
        // image model" against an unkinded list would match the video row and
        // report a block renderer as a still one.
        let v: serde_json::Value = serde_json::from_str(r#"{"desktop": {
          "models": {
            "h3": {"modes": {"i2v": {"checkpoint": "a.safetensors"}}},
            "shared": {"modes": {"t2v": {"checkpoint": "gone.safetensors"}}}
          },
          "image_models": {
            "shared": {"modes": {"t2i": {"checkpoint": "a.safetensors"}}},
            "qwen-edit": {"modes": {"edit": {"checkpoint": "b.safetensors"}}}
          }
        }}"#).unwrap();
        let have = ["a.safetensors", "b.safetensors"];
        let got = render_models_from(&v, |_d, f| have.contains(&f));

        let find = |kind: &str, key: &str| got.iter()
            .find(|m| m.kind == kind && m.key == key)
            .unwrap_or_else(|| panic!("no {kind} row for {key}"));
        assert_eq!(got.len(), 4);
        assert!(find("video", "h3").ready);
        assert!(find("image", "qwen-edit").ready);
        // One name, two sections, two different answers.
        assert!(!find("video", "shared").ready);
        assert!(find("image", "shared").ready);
        assert_eq!(find("video", "shared").missing, vec!["gone.safetensors"]);
        // Stable order: video before image, keys sorted within each.
        let order: Vec<String> = got.iter().map(|m| format!("{}/{}", m.kind, m.key)).collect();
        assert_eq!(order, ["image/qwen-edit", "image/shared", "video/h3", "video/shared"]);
    }

    #[test]
    fn an_entry_naming_no_weight_file_is_never_ready() {
        // NOTHING FOUND IS NOT NOTHING MISSING. SenseNova is the live case: a
        // transformers checkpoint at `model_path: "/data/models/sensenova/…"`,
        // an absolute POD path outside ComfyUI's model tree, so the weight
        // scan sees nothing and "every file present" is vacuously true. It was
        // offered under "on this machine" on a laptop that had none of it.
        let v: serde_json::Value = serde_json::from_str(r#"{"desktop": {
          "image_models": {
            "sensenova-u1": {"family": "sensenova",
                             "model_path": "/data/models/sensenova/U1.5-8B"}
          }
        }}"#).unwrap();
        let got = render_models_from(&v, |_d, _f| true);   // everything present
        assert_eq!(got.len(), 1);
        assert!(!got[0].ready, "an unjudgeable entry must not read as ready");
        assert!(got[0].missing.is_empty(), "there is nothing to name as missing");
    }

    #[test]
    fn from_model_is_followed_so_an_heir_is_judged_on_what_it_inherits() {
        // `h3-image` is `minimax-h3` plus a one-frame decoder. Judged on its
        // own keys it reports READY with the 32GB of checkpoints it renders on
        // still missing — after which the wizard plans an episode's sheets
        // onto this machine and every one dies on its first resolve.
        let v: serde_json::Value = serde_json::from_str(r#"{"desktop": {
          "models": {
            "minimax-h3": {"vae": "h3_vae.safetensors",
                           "modes": {"r2v": {"checkpoint": "ref2va.safetensors"}}}
          },
          "image_models": {
            "h3-image": {"from_model": "minimax-h3",
                         "image_vae": "t1_image_vae.safetensors"}
          }
        }}"#).unwrap();
        let have = ["t1_image_vae.safetensors"];   // the decoder only
        let got = render_models_from(&v, |_d, f| have.contains(&f));
        let h3img = got.iter().find(|m| m.key == "h3-image").unwrap();
        assert!(!h3img.ready);
        assert!(h3img.missing.contains(&"ref2va.safetensors".to_string()));
        assert!(h3img.missing.contains(&"h3_vae.safetensors".to_string()));
        // And with the parent's files down too, it is ready.
        let all = ["t1_image_vae.safetensors", "ref2va.safetensors", "h3_vae.safetensors"];
        let got = render_models_from(&v, |_d, f| all.contains(&f));
        assert!(got.iter().find(|m| m.key == "h3-image").unwrap().ready);
    }

    #[test]
    fn a_from_model_cycle_terminates_rather_than_hanging_the_command() {
        let v: serde_json::Value = serde_json::from_str(r#"{"desktop": {
          "image_models": {
            "a": {"from_model": "b", "vae": "a.safetensors"},
            "b": {"from_model": "a", "vae": "b.safetensors"}
          }
        }}"#).unwrap();
        let got = render_models_from(&v, |_d, _f| false);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|m| !m.ready));
    }

    #[test]
    fn a_map_with_no_image_table_is_a_real_state_rather_than_an_error() {
        // The generator drops an entry whose files the engine window cannot
        // fetch, so a section can legitimately empty out. Returning nothing at
        // all for the OTHER section would take block rendering with it.
        let v: serde_json::Value = serde_json::from_str(
            r#"{"desktop": {"models": {"h3": {}}}}"#).unwrap();
        let got = render_models_from(&v, |_d, _f| true);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "video");
    }

    #[test]
    fn a_weight_is_looked_for_in_the_directory_its_own_loader_reads() {
        // ComfyUI resolves each loader against ITS OWN subdirectory, so one
        // guessed directory for all of them would report a present file as
        // missing — on a machine holding every byte, which is the most
        // confusing possible answer to "why can I not render".
        let entry: serde_json::Value = serde_json::from_str(r#"{
          "vae": "video_vae.safetensors",
          "audio_vae": "audio_vae.safetensors",
          "text_encoders": ["qwen3vl.safetensors"],
          "turbo_lora": "turbo.safetensors",
          "latent_upscaler": "up.safetensors",
          "style_loras": {"combat": "h3_combat_v2.safetensors"},
          "modes": {
            "r2v": {"workflow": "x.json", "checkpoint": "ref2va.safetensors"},
            "i2v": {"workflow": "y.json", "checkpoint": "fl2va.safetensors"}
          }
        }"#).unwrap();
        let mut got = Vec::new();
        collect_weights(&entry, None, &mut got);

        assert!(got.contains(&("vae".into(), "video_vae.safetensors".into())));
        assert!(got.contains(&("vae".into(), "audio_vae.safetensors".into())));
        assert!(got.contains(&("text_encoders".into(), "qwen3vl.safetensors".into())));
        assert!(got.contains(&("loras".into(), "turbo.safetensors".into())));
        assert!(got.contains(&("latent_upscale_models".into(), "up.safetensors".into())));
        assert!(got.contains(&("diffusion_models".into(), "ref2va.safetensors".into())));
        assert!(got.contains(&("diffusion_models".into(), "fl2va.safetensors".into())));

        // An OPTIONAL adapter is not a reason to call a model unrenderable —
        // and the generator has already pruned that table to what is
        // downloadable, so anything left in it is a pick, not a requirement.
        assert!(!got.iter().any(|(_, f)| f == "h3_combat_v2.safetensors"));
        // Nothing that is not a weight file gets in.
        assert!(!got.iter().any(|(_, f)| f.ends_with(".json")));
    }

    /// The PDD files land where the PACK reads them, which is neither of the
    /// two directories the surrounding arms would choose.
    #[test]
    fn the_pdd_distillation_is_looked_for_in_the_folder_its_own_pack_registers() {
        let entry: serde_json::Value = serde_json::from_str(r#"{
          "pdd": {"fl2va": "MiniMax-H3-FL2VA-Acc-8Step.safetensors",
                  "ref2va": "MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
                  "nfe": "8"},
          "modes": {"t2v": {"checkpoint": "fl2va.safetensors"}}
        }"#).unwrap();
        let mut got = Vec::new();
        collect_weights(&entry, None, &mut got);
        got.sort();
        assert_eq!(got, vec![
            ("diffusion_models".to_string(), "fl2va.safetensors".to_string()),
            ("pdd_acc".to_string(), "MiniMax-H3-FL2VA-Acc-8Step.safetensors".to_string()),
            ("pdd_acc".to_string(), "MiniMax-H3-Ref2VA-Acc-8Step.safetensors".to_string()),
        ]);
        // `nfe` is a step count, not a file — nothing that is not a weight
        // gets in, which is what keeps the block from naming a phantom.
        assert!(!got.iter().any(|(_, f)| f == "8"));
    }

    #[test]
    fn a_gguf_is_looked_for_where_the_ENGINE_WINDOW_PUT_IT() {
        // `models/diffusion_models`, not `models/unet`. The pod maps a `gguf`
        // entry to `unet` (`resolve.ensure_model`) and that convention is not
        // this tree's: `engineCatalog`'s `gguf()` helper writes every quantised
        // file to `diffusion_models`, which is also the only one of the two
        // that `MODEL_DIRS` scans.
        //
        // Left as `unet`, a quantised entry reported EVERY file missing however
        // complete the download was, and the wizard sent someone to the cloud
        // for a block this machine can render. It was latent until the desktop
        // grew quantised H3 entries, because until then nothing under
        // `/desktop/models` named a `.gguf` at all.
        let entry: serde_json::Value = serde_json::from_str(r#"{
          "gguf": true,
          "modes": {"t2v": {"checkpoint": "MiniMax-H3-FL2VA-Q4_K_M.gguf"},
                    "r2v": {"checkpoint": "MiniMax-H3-Ref2VA-Q4_K_M.gguf"}}
        }"#).unwrap();
        let mut got = Vec::new();
        collect_weights(&entry, None, &mut got);
        got.sort();
        assert_eq!(got, vec![
            ("diffusion_models".to_string(), "MiniMax-H3-FL2VA-Q4_K_M.gguf".to_string()),
            ("diffusion_models".to_string(), "MiniMax-H3-Ref2VA-Q4_K_M.gguf".to_string()),
        ]);
    }

    #[test]
    fn a_checkpoint_counts_as_present_in_either_of_comfyui_s_two_folders() {
        // ComfyUI treats `models/unet` and `models/diffusion_models` as ONE
        // folder key, and city96's GGUF loader registers both — so a LINKED
        // ComfyUI may legitimately file a checkpoint under either. Ours writes
        // to `diffusion_models`; someone else's tree is not ours to have an
        // opinion about, and calling their model missing would send them to the
        // cloud for a render they can already do.
        let tmp = std::env::temp_dir().join(format!("qamba-present-{}", std::process::id()));
        let unet = tmp.join("unet");
        std::fs::create_dir_all(&unet).unwrap();
        std::fs::write(unet.join("theirs.gguf"), b"x").unwrap();

        assert!(present(&tmp, "diffusion_models", "theirs.gguf"),
            "a GGUF under models/unet is on disk, whichever directory we would have used");
        assert!(!present(&tmp, "diffusion_models", "absent.gguf"));
        // The fallback is for those two only — a VAE in `unet` is a VAE the VAE
        // loader cannot see, and pretending otherwise hides a real misfiling.
        assert!(!present(&tmp, "vae", "theirs.gguf"));

        let ours = tmp.join("diffusion_models");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("ours.gguf"), b"x").unwrap();
        assert!(present(&tmp, "diffusion_models", "ours.gguf"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn only_the_keys_a_pipeline_job_can_actually_spend_are_passed() {
        let ids: Vec<&str> = PLANNER_KEYS.iter().map(|(p, _)| *p).collect();
        assert_eq!(ids, vec!["anthropic", "openai", "google", "elevenlabs", "fish"]);
        // fal is a GENERATION key and every kind that could spend one resolves
        // its graph through the POD's model map, so it is never in this list —
        // an exposure with nothing here to spend it on. Hosted BYOK rendering
        // is `byok_gen`, which runs in the webview and never reaches this
        // process's environment at all.
        assert!(!ids.contains(&"fal"));
    }

    #[test]
    fn every_planner_key_names_the_variable_llm_py_actually_reads() {
        // `llm._key` looks up ANTHROPIC_API_KEY / OPENAI_API_KEY, and
        // `byok.ENV` maps google -> GEMINI_API_KEY. A wrong name here is a key
        // that is present in the environment and never found — which reads as
        // "the planner ignored my key".
        let m: BTreeMap<&str, &str> = PLANNER_KEYS.iter().copied().collect();
        assert_eq!(m["anthropic"], "ANTHROPIC_API_KEY");
        assert_eq!(m["openai"], "OPENAI_API_KEY");
        assert_eq!(m["google"], "GEMINI_API_KEY");
        // `dialogue_synth.enabled()` reads exactly this one, and returns False
        // without it — which is a plan that silently keeps the
        // words-per-second floor instead of measuring the real lines.
        assert_eq!(m["elevenlabs"], "ELEVENLABS_API_KEY");
        assert_eq!(m["fish"], "FISH_API_KEY");
    }

    /// THE UNIT IS ALWAYS CLEARED, and that is the load-bearing half.
    ///
    /// `worker/breeze_tts.py` reads an empty `BREEZE_UNIT` as "there is no
    /// systemd here" and stops shelling out to `sudo -n systemctl`. Left
    /// UNSET, the module's own default (`breeze-tts`) applies and a desktop
    /// refusal reads "could not start breeze-tts (sudo -n systemctl start)" —
    /// a fix for a machine the reader does not have.
    #[test]
    fn the_units_are_cleared_on_the_desktop_whether_or_not_anything_answers() {
        for b in [true, false] {
            for q in [true, false] {
                let m: BTreeMap<&str, String> = speech_env(b, q).into_iter().collect();
                for unit in ["BREEZE_UNIT", "QWEN_UNIT"] {
                    assert_eq!(m.get(unit), Some(&String::new()),
                               "{unit} must be cleared, breeze={b} qwen={q}");
                }
            }
        }
    }

    /// A plan casts every character a voice at PLAN time, so pointing it at a
    /// service that is not running fails at the first line — after the writer,
    /// the editor and the cinematographer have all run. Unset, the same
    /// function falls to ElevenLabs on the user's own key.
    #[test]
    fn an_engine_is_named_to_the_child_only_when_it_answers() {
        let up: BTreeMap<&str, String> = speech_env(true, true).into_iter().collect();
        assert_eq!(up.get("BREEZE_TTS_URL"), Some(&format!("http://127.0.0.1:{}",
                                                           crate::breeze::PORT)));
        assert_eq!(up.get("QWEN_TTS_URL"), Some(&format!("http://127.0.0.1:{}",
                                                         crate::qwen::PORT)));
        assert_eq!(up.get("DIALOGUE_PROVIDER"), Some(&"breeze".to_string()));

        let down: BTreeMap<&str, String> = speech_env(false, false).into_iter().collect();
        assert!(!down.contains_key("BREEZE_TTS_URL"));
        assert!(!down.contains_key("QWEN_TTS_URL"));
        assert!(!down.contains_key("DIALOGUE_PROVIDER"));
    }

    /// EACH ENGINE IS NAMED ON ITS OWN. Told about only one, a plan the wizard
    /// cast on the other finds its server unreachable and `resolve_provider`
    /// falls back with a log line — the pick defeated, on a machine where the
    /// engine was installed and running.
    #[test]
    fn one_engine_up_names_that_one_and_not_the_other() {
        let q: BTreeMap<&str, String> = speech_env(false, true).into_iter().collect();
        assert!(!q.contains_key("BREEZE_TTS_URL"));
        assert_eq!(q.get("QWEN_TTS_URL"), Some(&format!("http://127.0.0.1:{}",
                                                        crate::qwen::PORT)));
        // With Breeze absent the only engine there IS becomes the default —
        // otherwise a plan naming nothing falls through to ElevenLabs (or to
        // the words-per-second guess) on a machine that can speak.
        assert_eq!(q.get("DIALOGUE_PROVIDER"), Some(&"qwen".to_string()));

        let b: BTreeMap<&str, String> = speech_env(true, false).into_iter().collect();
        assert!(!b.contains_key("QWEN_TTS_URL"));
        assert_eq!(b.get("DIALOGUE_PROVIDER"), Some(&"breeze".to_string()));
    }

    /// The wizard's own default is Breeze, and it is the engine that can DIRECT
    /// a line — so on a machine with both, naming Qwen here would quietly
    /// re-cast every plan that specified nothing.
    #[test]
    fn breeze_leads_when_both_answer() {
        let m: BTreeMap<&str, String> = speech_env(true, true).into_iter().collect();
        assert_eq!(m.get("DIALOGUE_PROVIDER"), Some(&"breeze".to_string()));
    }
}
