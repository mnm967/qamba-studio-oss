//! Breeze TTS 2 on this machine — the studio's dialogue engine, offline.
//!
//! THE SECOND DAEMON, and shaped like the first (`ollama.rs`) rather than
//! invented: a pinned download, our own child and nobody else's, a port we do
//! not fight for, a jobs registry that outlives the screen, and a pure action
//! table on the TypeScript side. Every one of those was a bug there first.
//!
//! WHY IT IS NOT AN `engineCatalog` FAMILY. That catalogue is ComfyUI-shaped —
//! `ModelDir` is a closed union of ComfyUI's own subdirectories and every entry
//! is a flat file a loader reads by name. Breeze is a SERVICE: its own venv,
//! its own torch pin (2.9.1, which must never touch the engine's), a
//! transformers checkpoint that is a DIRECTORY of twelve files across two
//! levels, and an HTTP API on :7860. Nothing in that catalogue can express any
//! of it, and bending it to would make every weight row carry fields only one
//! entry uses.
//!
//! WHAT THE PYTHON ALREADY DOES. `worker/breeze_tts.py` speaks the protocol and
//! has since the pod ran it; the only pod-shaped part was starting and stopping
//! a systemd unit. `BREEZE_UNIT=""` is how `planner.rs` says there is none here,
//! and this module is what start/stop means instead.
//!
//! LICENCE: the weights are BreezeBlue Research and NON-COMMERCIAL — the
//! weights AND their outputs. The code is Apache-2.0. Said on the card, not
//! buried here.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Where the service answers. The same literal `worker/breeze_tts.py` is
/// handed through `BREEZE_TTS_URL`, and the pod's own unit uses it too.
pub const PORT: u16 = 7860;

/// PINNED, unlike the pod's `git clone --depth 1`.
///
/// An install that silently changes behaviour between two users is not
/// reproducible, and this one carries a device shim we patch — a moving HEAD
/// would eventually move the file out from under it. GitHub unpacks
/// `archive/<sha>.tar.gz` as `<repo>-<sha>`, which `unpacked_name` derives.
const APP_REV: &str = "d76819fa9c04";
const APP_TARBALL: &str =
    "https://github.com/breezeblue-ai/breeze-tts/archive/d76819fa9c04.tar.gz";

/// The weights, as measured on the hub rather than listed from it.
///
/// HARDCODED ON PURPOSE. Reading the tree API at install time makes the set a
/// moving target — a file added upstream would be fetched by some machines and
/// not others, and "installed" would stop being a question with one answer. A
/// mismatch is then a version bump somebody makes deliberately, which is the
/// same trade `APP_REV` takes.
///
/// 7.16 GiB total, and the sizes are MEBIBYTES — bytes / 1048576, like the
/// weight catalogue. They first went in as bytes / 1e6, which overstates every
/// file by 4.8%; the same mistake was caught on MMAudio by the pod publisher's
/// size guard, and there is no such guard on this path, so it is written down
/// here instead. a mirror publisher reads this list.
///
/// `audio_tokenizer/` is REQUIRED beside the model (the runtime loads it as a
/// peer, not as an option) and is the reason this is a SET rather than a
/// dozen files: the weight mirror basenames everything and its index is flat,
/// so neither can hold a two-level directory.
/// The set's id on the mirror, and the key `engine_services.json` files it
/// under. Matches the catalogue row so one name addresses both.
const SET_ID: &str = "breeze-tts-2";
const SET_PREFIX: &str = "engine/sets/";
const WEIGHTS_REPO: &str = "BreezeBlue/Breeze-TTS-2";
/// PINNED, like the code above, and for a sharper reason: `main` can move
/// under a HALF-FINISHED install. `download_file_set` resumes at file and byte
/// granularity, so a revision that changed between two runs would splice two
/// checkpoints into one directory and the failure would be a model that loads
/// and speaks wrongly. It is also part of the mirror KEY
/// (`engine/sets/<id>/<rev>/<path>`), so two revisions can coexist there and a
/// desktop can never mix files from both.
const WEIGHTS_REV: &str = "799624c0b4a1daa8db6d28bbd9850043c0270734";
const WEIGHTS: &[(&str, u64)] = &[
    ("config.json", 1),
    ("generation_config.json", 1),
    ("model.safetensors.index.json", 1),
    ("special_tokens_map.json", 1),
    ("tokenizer.json", 32),
    ("tokenizer_config.json", 1),
    ("model-00001-of-00002.safetensors", 4732),
    ("model-00002-of-00002.safetensors", 1912),
    ("audio_tokenizer/config.json", 1),
    ("audio_tokenizer/configuration.json", 1),
    ("audio_tokenizer/preprocessor_config.json", 1),
    ("audio_tokenizer/model.safetensors", 651),
];

/// Requirements we deliberately do not install: the upstream file pins its own
/// dev tools, and neither is reachable from a served request.
const SKIP_REQS: &[&str] = &["pytest", "ruff"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BreezeStatus {
    /// the checkout, the venv and every weight are on disk
    pub installed: bool,
    /// the pinned source tree is unpacked
    pub code: bool,
    /// its virtualenv exists and imports `breeze_infer`
    pub venv: bool,
    /// weights present, in MB, against `weights_total_mb`
    pub weights_mb: u64,
    pub weights_total_mb: u64,
    /// files still to fetch, by relative path
    pub weights_missing: Vec<String>,
    /// something answers `/health` on the port
    pub reachable: bool,
    /// ...and it is OUR child. `reachable && !ours` is `foreign`.
    pub ours: bool,
    /// our child is alive and `/health` has not answered yet. A 3B model takes
    /// 30-60s to load, longer on a Mac, and a status that reported it as down
    /// would make the Start button look like it did nothing.
    pub starting: bool,
    /// something else holds the port. NEVER stopped from here — that process
    /// is somebody else's, exactly as `ollama.rs` states for :11434.
    pub foreign: bool,
    /// what the last start resolved to (`cuda`, `mps`, `cpu`), when known
    pub device: Option<String>,
    pub rev: String,
    pub port: u16,
    pub root: String,
    pub license: String,
}

pub struct BreezeProc(pub Mutex<Option<std::process::Child>>);

impl Default for BreezeProc {
    fn default() -> Self {
        BreezeProc(Mutex::new(None))
    }
}

#[derive(Clone, Serialize)]
pub struct BreezeProgress {
    pub label: String,
    /// 0.0..=1.0, or -1 for a step with no measurable size
    pub pct: f64,
    pub detail: String,
    /// which operation — `""` is the install, the only one there is today.
    pub key: String,
}

/// In-flight work, so a closed modal does not lose it. Same reasoning as
/// `OllamaJobs` and `Downloads`: an install outlives the screen that started
/// it, and a second offer would open a second writer.
#[derive(Default)]
pub struct BreezeJobs(pub Mutex<std::collections::HashMap<String, BreezeProgress>>);

struct JobGuard {
    app: AppHandle,
    key: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<BreezeJobs>() {
            if let Ok(mut m) = state.0.lock() {
                m.remove(&self.key);
            }
        }
    }
}

fn claim(app: &AppHandle, key: &str, label: &str) -> Option<JobGuard> {
    let state = app.try_state::<BreezeJobs>()?;
    let mut m = state.0.lock().ok()?;
    if m.contains_key(key) {
        return None;
    }
    m.insert(key.to_string(), BreezeProgress {
        label: label.into(), pct: -1.0, detail: String::new(), key: key.into(),
    });
    Some(JobGuard { app: app.clone(), key: key.to_string() })
}

fn emit(app: &AppHandle, key: &str, label: &str, pct: f64, detail: &str) {
    let p = BreezeProgress {
        label: label.into(), pct, detail: detail.into(), key: key.into(),
    };
    // Into the registry as well as onto the wire — an event only reaches a
    // screen already listening, and the point is the one that was closed.
    if let Some(state) = app.try_state::<BreezeJobs>() {
        if let Ok(mut m) = state.0.lock() {
            if let Some(e) = m.get_mut(key) {
                *e = p.clone();
            }
        }
    }
    let _ = app.emit("breeze://progress", p);
}

#[tauri::command]
pub fn breeze_active(app: AppHandle) -> Vec<BreezeProgress> {
    app.try_state::<BreezeJobs>()
        .and_then(|s| s.0.lock().ok().map(|m| m.values().cloned().collect()))
        .unwrap_or_default()
}

/* ── layout ──────────────────────────────────────────────────────────────── */

pub fn root_dir(app: &AppHandle) -> PathBuf {
    crate::engine::engine_root(app).join("breeze")
}

fn app_dir(app: &AppHandle) -> PathBuf {
    root_dir(app).join("app")
}

fn weights_dir(app: &AppHandle) -> PathBuf {
    root_dir(app).join("weights")
}

fn venv_python(root: &Path) -> PathBuf {
    let v = root.join("venv");
    if cfg!(target_os = "windows") {
        v.join("Scripts").join("python.exe")
    } else {
        v.join("bin").join("python3")
    }
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// `https://github.com/owner/repo/archive/<rev>.tar.gz` -> `repo-<rev>`.
///
/// GitHub names the unpacked directory after the ref, so this has to agree
/// with the URL or the rename finds nothing and the install reads as having
/// silently done nothing.
fn unpacked_name(url: &str, rev: &str) -> String {
    let repo = url.split("/archive/").next().unwrap_or("")
        .rsplit('/').next().unwrap_or("");
    format!("{repo}-{rev}")
}

/// Which weight files are still missing, and how many MB are present.
fn weights_state(dir: &Path) -> (u64, u64, Vec<String>) {
    let mut have = 0u64;
    let mut missing = Vec::new();
    for (rel, mb) in WEIGHTS {
        let p = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if p.is_file() {
            have += mb;
        } else {
            missing.push((*rel).to_string());
        }
    }
    (have, WEIGHTS.iter().map(|(_, mb)| mb).sum(), missing)
}

/// Rewrite `preferred_attn_implementation` to `eager`, idempotently.
///
/// THE PUBLISHED CONFIG ASKS FOR FLASHATTENTION-2 AND THE RUNTIME REFUSES TO
/// START WITHOUT IT rather than degrading — `ImportError: FlashAttention2 has
/// been toggled on`, a crash loop after a clean install. Measured on the pod
/// 2026-09-01, and the same rewrite the engine window's Speech tab makes there.
///
/// Pure so the JSON handling is testable without a 7.7GB download.
pub fn eager_config(json: &str) -> Result<String, String> {
    let mut v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let obj = v.as_object_mut().ok_or("config.json is not an object")?;
    obj.insert("preferred_attn_implementation".into(),
               serde_json::Value::String("eager".into()));
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// Where each weight file should be fetched from.
///
/// ALL-OR-NOTHING, and that is the whole design. The mirror is keyed by
/// revision (`engine/sets/<id>/<rev>/<path>`) and its index lists a set only
/// when EVERY file of that revision is present — so a half-published set can
/// never hand a desktop six files from here and a 404 on the seventh, six
/// gigabytes in. A mixed set would also be the worse failure: two revisions
/// spliced into one checkpoint directory is a model that loads and speaks
/// wrongly, where falling back whole costs only speed.
///
/// Anything unexpected — no CDN configured, an unreachable index, a different
/// revision, a missing file — falls back to the hub, which is ungated and
/// works everywhere. The mirror is speed, not access.
async fn mirror_base(cdn: Option<&str>) -> Option<String> {
    use tauri_plugin_http::reqwest;
    let base = cdn.map(|c| c.trim_end_matches('/'))?;
    if base.is_empty() {
        return None;
    }
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .ok()?;
    // Cache-busted: this is the one MUTABLE object under a prefix the CDN
    // caches for 30 days, and reading a stale copy is how a full mirror reads
    // as empty. The weight index has the same note for the same reason.
    let url = format!("{base}/{SET_PREFIX}index.json?t={}",
                      std::time::SystemTime::now()
                          .duration_since(std::time::UNIX_EPOCH)
                          .map(|d| d.as_secs()).unwrap_or(0));
    let body = c.get(url).send().await.ok()?.text().await.ok()?;
    let doc: serde_json::Value = serde_json::from_str(&body).ok()?;
    let set = doc.get("sets")?.get(SET_ID)?;
    if set.get("rev")?.as_str()? != WEIGHTS_REV {
        return None;
    }
    let listed: std::collections::HashSet<&str> = set.get("files")?
        .as_array()?.iter().filter_map(|v| v.as_str()).collect();
    if !WEIGHTS.iter().all(|(rel, _)| listed.contains(rel)) {
        return None;
    }
    Some(format!("{base}/{SET_PREFIX}{SET_ID}/{WEIGHTS_REV}"))
}

async fn health() -> bool {
    use tauri_plugin_http::reqwest;
    let Ok(c) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
    else {
        return false;
    };
    c.get(format!("{}/health", base_url())).send().await
        .map(|r| r.status().is_success()).unwrap_or(false)
}

/// Reachable from anywhere in the crate, for `plan_run`'s env decision.
pub async fn is_serving() -> bool {
    health().await
}

#[tauri::command]
pub async fn breeze_status(
    app: AppHandle, proc: State<'_, BreezeProc>,
) -> Result<BreezeStatus, String> {
    let root = root_dir(&app);
    let code = app_dir(&app).join("breeze_infer").join("api.py").is_file();
    let venv = venv_python(&root).is_file();
    let (mb, total, missing) = weights_state(&weights_dir(&app));

    // Ours, by the only honest test — our own child, the same question
    // `engine_status` asks about ComfyUI.
    let ours_alive = match proc.0.lock() {
        Ok(mut g) => match g.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(_)) => { *g = None; false }
                Err(_) => false,
            },
            None => false,
        },
        Err(_) => false,
    };
    let reachable = health().await;

    Ok(BreezeStatus {
        installed: code && venv && missing.is_empty(),
        code,
        venv,
        weights_mb: mb,
        weights_total_mb: total,
        weights_missing: missing,
        reachable,
        ours: ours_alive && reachable,
        // Alive and not answering yet: loading a 3B model takes 30-60s, and a
        // status that called that "down" would make Start look inert.
        starting: ours_alive && !reachable,
        foreign: reachable && !ours_alive,
        device: std::fs::read_to_string(root.join("device.txt")).ok()
            .map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        rev: APP_REV.into(),
        port: PORT,
        root: root.to_string_lossy().into_owned(),
        license: "BreezeBlue Research — non-commercial, weights and outputs".into(),
    })
}

/* ── install ─────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn install_breeze(
    app: AppHandle, force: Option<bool>, cdn_base: Option<String>,
) -> Result<(), String> {
    let Some(_guard) = claim(&app, "", "Installing Breeze TTS 2") else {
        return Err("Breeze is already installing".into());
    };
    let force = force.unwrap_or(false);
    let root = root_dir(&app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // 1. THE ENGINE'S OWN PYTHON, which the venv is built from. Refused rather
    //    than downloaded again: it is the same interpreter ComfyUI and the
    //    pipeline use, and a second copy is gigabytes for nothing.
    let engine_root = crate::engine::engine_root(&app);
    let py = crate::engine::python_bin(&engine_root);
    if !py.is_file() {
        return Err("Breeze needs the studio's Python — take \"Utilities only\" \
                    (or the full install) on the Engine tab first.".into());
    }

    // 2. the pinned source tree
    let appd = app_dir(&app);
    if force || !appd.join("breeze_infer").join("api.py").is_file() {
        emit(&app, "", "Downloading Breeze TTS 2", -1.0, "the inference server");
        let tgz = root.join("app.tar.gz");
        // `None`: this install has a channel of its own (`breeze://progress`),
        // and the engine's would put a spurious step 1 in the Engine tab.
        crate::engine::download_to(&app, APP_TARBALL, &tgz, None,
                                   "Downloading Breeze TTS 2")
            .await?;
        let _ = std::fs::remove_dir_all(&appd);
        crate::engine::untar(&tgz, &root)?;
        let _ = std::fs::remove_file(&tgz);
        let un = root.join(unpacked_name(APP_TARBALL, APP_REV));
        if un.is_dir() {
            std::fs::rename(&un, &appd).map_err(|e| e.to_string())?;
        }
    }

    // 3. the venv and its own torch. NEVER THE ENGINE'S: upstream pins
    //    torch==2.9.1 and the engine renders on its own build, so sharing one
    //    environment means one of the two is wrong. The cost is ~2GB of
    //    duplicate torch, which is the correct trade.
    let vpy = venv_python(&root);
    if force || !vpy.is_file() {
        emit(&app, "", "Creating the Breeze environment", -1.0, "");
        crate::engine::run_python(
            &py, &["-m", "venv", &root.join("venv").to_string_lossy()], &root)?;
    }
    emit(&app, "", "Installing Breeze dependencies", -1.0, "a few minutes");
    let req = appd.join("requirements.txt");
    let body = std::fs::read_to_string(&req)
        .map_err(|e| format!("the checkout has no requirements.txt: {e}"))?;
    let filtered: String = body.lines()
        .filter(|l| {
            let name = l.trim().split(['=', '>', '<', '[', ';', ' ']).next().unwrap_or("");
            !SKIP_REQS.contains(&name)
        })
        .collect::<Vec<_>>().join("\n");
    let reqf = root.join("requirements.txt");
    std::fs::write(&reqf, filtered).map_err(|e| e.to_string())?;
    crate::engine::run_python(
        &vpy, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                "--upgrade", "pip"], &root)?;
    // Windows + an NVIDIA card takes the CUDA index, exactly as the engine's
    // own torch does; everywhere else PyPI carries what this machine can use.
    let mut targs: Vec<String> = ["-m", "pip", "install", "--disable-pip-version-check",
                                  "-q", "-r"].iter().map(|s| s.to_string()).collect();
    targs.push(reqf.to_string_lossy().into_owned());
    for a in crate::engine::torch_index_args(cfg!(target_os = "windows"),
                                             crate::engine::has_nvidia()) {
        targs.push(a.to_string());
    }
    let refs: Vec<&str> = targs.iter().map(|s| s.as_str()).collect();
    crate::engine::run_python(&vpy, &refs, &root)?;

    // 4. the weights, through the same downloader every model file uses —
    //    resumable, HTML-refusing, and ONE entry in the queue popover.
    let wdir = weights_dir(&app);
    let (_, _, missing) = weights_state(&wdir);
    if !missing.is_empty() {
        // ONE probe decides the source for the whole set — see `mirror_base`.
        let mirror = mirror_base(cdn_base.as_deref()).await;
        emit(&app, "", "Downloading the voice weights", -1.0,
             if mirror.is_some() { "7.2 GiB from the studio's mirror" }
             else { "7.2 GiB from HuggingFace" });
        let files: Vec<crate::SetFile> = WEIGHTS.iter().map(|(rel, mb)| crate::SetFile {
            url: match mirror.as_deref() {
                Some(b) => format!("{b}/{rel}"),
                None => format!(
                    "https://huggingface.co/{WEIGHTS_REPO}/resolve/{WEIGHTS_REV}/{rel}"),
            },
            path: (*rel).to_string(),
            size_mb: Some(*mb),
            sha256: None,
        }).collect();
        crate::fetch_file_set(
            app.clone(), "breeze-weights".into(), wdir.to_string_lossy().into_owned(),
            files, None, Some("breeze".into())).await?;
    }

    // 5. the eager rewrite — without it the server crash-loops on import.
    let cfg = wdir.join("config.json");
    if let Ok(txt) = std::fs::read_to_string(&cfg) {
        if let Ok(fixed) = eager_config(&txt) {
            let _ = std::fs::write(&cfg, fixed);
        }
    }

    // 6. prove it imports, and record what device it will use. A venv that
    //    installed and cannot import is the failure worth catching HERE, not
    //    at the first line somebody asks for.
    emit(&app, "", "Checking the install", -1.0, "");
    let probe = crate::engine::run_python(&vpy, &["-c",
        "import torch, breeze_infer;\
         mps=getattr(torch.backends,'mps',None);\
         print('cuda' if torch.cuda.is_available() else \
               ('mps' if mps and mps.is_available() else 'cpu'))"], &root)?;
    let _ = std::fs::write(root.join("device.txt"), probe.trim());
    emit(&app, "", "Breeze TTS 2 ready", 1.0, probe.trim());
    Ok(())
}

/* ── run ─────────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn start_breeze(
    app: AppHandle, proc: State<'_, BreezeProc>,
) -> Result<(), String> {
    // WE DO NOT FIGHT FOR THE PORT. Anything already answering is somebody
    // else's server — possibly the user's own Breeze — and starting a second
    // one would take a port we do not own and load 7.7GB beside theirs.
    if health().await {
        return Ok(());
    }
    {
        let mut g = proc.0.lock().map_err(|_| "breeze process lock is poisoned")?;
        if let Some(c) = g.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Ok(());
            }
            *g = None;
        }
    }
    let root = root_dir(&app);
    let vpy = venv_python(&root);
    let wdir = weights_dir(&app);
    if !vpy.is_file() || !wdir.join("config.json").is_file() {
        return Err("Breeze TTS 2 is not installed on this machine — \
                    install it from the engine window's Speech tab.".into());
    }
    let log = std::fs::File::create(root.join("breeze.log")).map_err(|e| e.to_string())?;
    let errlog = log.try_clone().map_err(|e| e.to_string())?;

    // `breeze_serve.py` rather than `-m breeze_infer.api`: upstream's
    // `resolve_device` knows only cuda and cpu, so on a Mac it silently lands
    // on the CPU. The shim prefers MPS when torch reports it and then calls
    // upstream's own `main()` — a monkeypatch at the boundary, so the pinned
    // checkout is never edited and an upstream bump does not fight a patch.
    let shim = crate::planner::worker_dir(&app)?.join("breeze_serve.py");
    let mut cmd = std::process::Command::new(&vpy);
    cmd.arg(&shim)
        .arg(&wdir)
        .arg("--host").arg("127.0.0.1")
        .arg("--port").arg(PORT.to_string())
        .current_dir(app_dir(&app))
        .env("PATH", crate::engine::child_path(&crate::engine::engine_root(&app)))
        // Not every op has an MPS kernel yet; falling back to the CPU for one
        // is a slower line, where refusing is no line at all.
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(errlog));
    let child = crate::hardware::no_window(&mut cmd).spawn().map_err(|e| e.to_string())?;
    *proc.0.lock().map_err(|_| "breeze process lock is poisoned")? = Some(child);

    // Do NOT wait for the model here. It is 7.7GB and 30-60s of loading, and
    // blocking the command that long makes the button look hung; `starting` is
    // what the screen renders in the meantime.
    Ok(())
}

#[tauri::command]
pub fn stop_breeze(proc: State<'_, BreezeProc>) -> Result<(), String> {
    // OUR CHILD ONLY. A Breeze the user started themselves is theirs.
    let mut g = proc.0.lock().map_err(|_| "breeze process lock is poisoned")?;
    if let Some(mut c) = g.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

/// Stop OUR child before a ComfyUI render, and say whether we did.
///
/// BREEZE SHARES THE GPU. Resident it holds ~8.5GB, measured beside ComfyUI on
/// the pod where it killed a 311-frame block outright. Every line an episode
/// needs is synthesised at PLAN time, so the service has nothing to do during
/// the render leg — `worker.py` parks it there and `localWorker` does the same
/// here. Nothing restarts it: `breeze_ensure_up` brings it back the moment a
/// line is asked for, so a render leg never pays the 8.5GB twice.
#[tauri::command]
pub fn breeze_park(proc: State<'_, BreezeProc>) -> Result<bool, String> {
    let mut g = proc.0.lock().map_err(|_| "breeze process lock is poisoned")?;
    match g.take() {
        Some(mut c) => {
            let _ = c.kill();
            let _ = c.wait();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Health, or start it and wait — the counterpart to `park`.
#[tauri::command]
pub async fn breeze_ensure_up(
    app: AppHandle, proc: State<'_, BreezeProc>, wait_s: Option<u64>,
) -> Result<bool, String> {
    if health().await {
        return Ok(true);
    }
    start_breeze(app.clone(), proc).await?;
    let deadline = wait_s.unwrap_or(180);
    for _ in 0..(deadline / 2).max(1) {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if health().await {
            return Ok(true);
        }
    }
    Err("Breeze TTS 2 started but never answered — see breeze.log in the \
         engine folder (the Speech tab links it).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The set is hardcoded so that "installed" has ONE answer; a mismatch
    /// with the hub is a version bump somebody makes on purpose. What must
    /// hold is that the peer directory the runtime loads is in it — the model
    /// alone is a server that starts and cannot speak.
    #[test]
    fn the_weight_list_is_the_one_measured_on_the_hub() {
        assert_eq!(WEIGHTS.len(), 12);
        let names: Vec<&str> = WEIGHTS.iter().map(|(n, _)| *n).collect();
        for want in ["config.json", "model-00001-of-00002.safetensors",
                     "model-00002-of-00002.safetensors",
                     "audio_tokenizer/model.safetensors",
                     "audio_tokenizer/config.json"] {
            assert!(names.contains(&want), "{want} is missing from WEIGHTS");
        }
        let total: u64 = WEIGHTS.iter().map(|(_, mb)| mb).sum();
        // MEBIBYTES. The band is tight enough to catch the 4.8% a decimal-MB
        // conversion adds — 7328 MiB read as MB is 7684, outside it.
        assert!((7_250..7_400).contains(&total),
                "7.16 GiB (7328 MiB) measured on the hub, got {total} MiB");
        // Every path must survive `safe_rel` — this is a set written under a
        // root we chose, and `audio_tokenizer/` is the reason it is a SET.
        for (rel, _) in WEIGHTS {
            assert!(crate::safe_rel(rel).is_ok(), "{rel} would be refused");
        }
    }

    /// The published config asks for FlashAttention-2 and the runtime REFUSES
    /// to start rather than degrading — a crash loop after a clean install.
    #[test]
    fn eager_config_rewrites_the_one_key_and_is_idempotent() {
        let src = r#"{"model_type":"breeze","preferred_attn_implementation":"flash_attention_2","x":1}"#;
        let once = eager_config(src).unwrap();
        assert!(once.contains("\"eager\""));
        assert!(!once.contains("flash_attention_2"));
        // Nothing else is touched: this is somebody's model config, not ours.
        assert!(once.contains("\"model_type\""));
        assert!(once.contains("\"x\""));
        assert_eq!(eager_config(&once).unwrap(), once, "must be idempotent");
        // A config with no such key gets one rather than being left to crash.
        assert!(eager_config(r#"{"a":1}"#).unwrap().contains("eager"));
        assert!(eager_config("not json").is_err());
    }

    /// GitHub names the unpacked directory after the REF, so a pinned sha
    /// unpacks as `<repo>-<sha>` where a branch gives `<repo>-main`. Getting
    /// this wrong finds no directory and the install silently does nothing.
    #[test]
    fn the_unpacked_directory_follows_the_pinned_ref() {
        assert_eq!(unpacked_name(APP_TARBALL, APP_REV), "breeze-tts-d76819fa9c04");
        assert!(APP_TARBALL.ends_with(&format!("{APP_REV}.tar.gz")),
                "the tarball and the rev must name the same commit");
    }

    #[test]
    fn weights_state_reports_what_is_missing_rather_than_a_boolean() {
        let tmp = std::env::temp_dir().join(format!("qamba-bz-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("audio_tokenizer")).unwrap();
        std::fs::write(tmp.join("config.json"), "{}").unwrap();
        let (have, total, missing) = weights_state(&tmp);
        assert_eq!(have, 1);
        assert!(total > 7_000);
        assert_eq!(missing.len(), WEIGHTS.len() - 1);
        // Named, not counted: "download it again" is not actionable when
        // eleven of twelve already landed.
        assert!(missing.iter().any(|m| m == "audio_tokenizer/model.safetensors"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The dev tools upstream pins are not reachable from a served request,
    /// and installing them is minutes of nothing on every machine.
    #[test]
    fn the_dev_pins_are_the_only_requirements_dropped() {
        assert_eq!(SKIP_REQS, &["pytest", "ruff"]);
        let req = "torch==2.9.1\nqwen-tts==0.1.1\npytest>=8.0\nruff>=0.12\nfastapi>=0.115\n";
        let kept: Vec<&str> = req.lines()
            .filter(|l| {
                let n = l.trim().split(['=', '>', '<', '[', ';', ' ']).next().unwrap_or("");
                !SKIP_REQS.contains(&n)
            })
            .collect();
        assert_eq!(kept, vec!["torch==2.9.1", "qwen-tts==0.1.1", "fastapi>=0.115"]);
    }
}
