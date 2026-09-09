//! Qwen3-TTS on the desktop — the SECOND local voice engine, and the first
//! whose weights this studio may ship commercially.
//!
//! `breeze.rs`'s shape throughout, because the two do the same job and the
//! screen that drives them is one screen. Where it differs, it differs for a
//! reason the reader should not have to reverse-engineer:
//!
//! * **TWO checkpoints, not one.** `Qwen3TTSModel` gates each method on the
//!   checkpoint's own `tts_model_type`: `generate_voice_design` raises unless
//!   it is the VoiceDesign one and `generate_voice_clone` raises unless it is
//!   Base. Design-only cannot carry a cast — nothing in the family takes a
//!   seed and `generation_config.json` is `do_sample: true, temperature: 0.9`,
//!   so a per-line re-design re-rolls the timbre on every line of a scene. So
//!   the PAIR is the unit, and "installed" means both.
//! * **No source tree to fetch.** Breeze downloads a pinned tarball of its
//!   inference server; ours is `worker/qwen_tts_serve.py`, already bundled as
//!   an app resource, because the `qwen-tts` package ships only a Gradio demo
//!   and there is no HTTP API upstream to point at.
//! * **No eager rewrite.** Breeze's published config demands FlashAttention-2
//!   and crash-loops without it; here the attention is resolved at load time
//!   by our own shim (`_attn`), so there is no config to patch.
//!
//! LICENCE: Apache 2.0, weights and code, not gated. That is the whole reason
//! this exists beside a working engine — Breeze's weights are BreezeBlue
//! Research and NON-COMMERCIAL, so the publisher demands `--yes` to mirror
//! them and this one it does not.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Deliberately NOT Breeze's 7860: a machine may serve both, and two engines
/// on one port is a silent "already running" that starts nothing.
pub const PORT: u16 = 7870;

const SET_PREFIX: &str = "engine/sets/";

/// The two halves of the pair. Each is its own mirror SET — one id, one rev,
/// one file list — because they are separate repos that move independently and
/// the mirror key is `engine/sets/<id>/<rev>/<path>`.
const DESIGN_SET_ID: &str = "qwen3-tts-voicedesign";
const DESIGN_REPO: &str = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign";
/// PINNED, for `breeze.rs`'s reason: `main` can move under a HALF-FINISHED
/// install, and `download_file_set` resumes at file and byte granularity — so
/// a revision that changed between two runs would splice two checkpoints into
/// one directory and the failure would be a model that loads and speaks
/// wrongly.
const DESIGN_REV: &str = "5ecdb67327fd37bb2e042aab12ff7391903235d3";
const DESIGN_WEIGHTS: &[(&str, u64)] = &[
    ("config.json", 1),
    ("generation_config.json", 1),
    ("merges.txt", 2),
    ("model.safetensors", 3834),
    ("preprocessor_config.json", 1),
    ("speech_tokenizer/config.json", 1),
    ("speech_tokenizer/configuration.json", 1),
    ("speech_tokenizer/model.safetensors", 683),
    ("speech_tokenizer/preprocessor_config.json", 1),
    ("tokenizer_config.json", 1),
    ("vocab.json", 3),
];

const CLONE_SET_ID: &str = "qwen3-tts-base";
const CLONE_REPO: &str = "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
const CLONE_REV: &str = "fd4b254389122332181a7c3db7f27e918eec64e3";
const CLONE_WEIGHTS: &[(&str, u64)] = &[
    ("config.json", 1),
    ("generation_config.json", 1),
    ("merges.txt", 2),
    ("model.safetensors", 3858),
    ("preprocessor_config.json", 1),
    ("speech_tokenizer/config.json", 1),
    ("speech_tokenizer/configuration.json", 1),
    ("speech_tokenizer/model.safetensors", 683),
    ("speech_tokenizer/preprocessor_config.json", 1),
    ("tokenizer_config.json", 1),
    ("vocab.json", 3),
];

/// The pip distribution that provides `Qwen3TTSModel`. NOT the name of our own
/// client module, which is `qwen_voice` precisely so it cannot shadow this one
/// on the server's `sys.path` — see `worker/qwen_voice.py`.
const PACKAGE: &str = "qwen-tts";

pub const LICENSE: &str = "Apache 2.0 — weights and code, no usage restriction";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QwenStatus {
    /// the venv and every weight of BOTH checkpoints are on disk
    pub installed: bool,
    /// its virtualenv exists and imports `qwen_tts`
    pub venv: bool,
    /// weights present, in MB, against `weights_total_mb` (both checkpoints)
    pub weights_mb: u64,
    pub weights_total_mb: u64,
    /// files still to fetch, as `<set>/<relative path>`
    pub weights_missing: Vec<String>,
    /// something answers `/health` on the port
    pub reachable: bool,
    /// ...and it is OUR child. `reachable && !ours` is `foreign`.
    pub ours: bool,
    /// our child is alive and `/health` has not answered yet. The server
    /// preloads ~9GB across two checkpoints, so this window is LONGER than
    /// Breeze's and a status that reported it down would make Start look dead.
    pub starting: bool,
    /// something else holds the port. NEVER stopped from here — that process
    /// is somebody else's, exactly as `ollama.rs` states for :11434.
    pub foreign: bool,
    /// what the last install resolved to (`cuda`, `mps`, `cpu`), when known
    pub device: Option<String>,
    pub port: u16,
    pub root: String,
    pub license: String,
    /// FALSE, and said in the status rather than discovered as a dropped
    /// delivery note: `generate_voice_clone` takes no `instruct`, so a cloned
    /// line here cannot be steered the way Breeze's can.
    pub supports_direction: bool,
}

pub struct QwenProc(pub Mutex<Option<std::process::Child>>);

impl Default for QwenProc {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QwenProgress {
    pub key: String,
    pub label: String,
    pub pct: f64,
    pub detail: String,
}

pub struct QwenJobs(pub Mutex<std::collections::HashMap<String, QwenProgress>>);

impl Default for QwenJobs {
    fn default() -> Self {
        Self(Mutex::new(std::collections::HashMap::new()))
    }
}

/// RAII, `breeze.rs`'s reason verbatim: the install has a dozen `?` early
/// returns and one missed cleanup leaves a phantom "already installing" that
/// only an app restart clears.
struct JobGuard {
    app: AppHandle,
    key: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(s) = self.app.try_state::<QwenJobs>() {
            if let Ok(mut m) = s.0.lock() {
                m.remove(&self.key);
            }
        }
        let _ = self.app.emit("qwen://progress", Vec::<QwenProgress>::new());
    }
}

fn claim(app: &AppHandle, key: &str, label: &str) -> Option<JobGuard> {
    let s = app.try_state::<QwenJobs>()?;
    {
        let mut m = s.0.lock().ok()?;
        if m.contains_key(key) {
            return None;
        }
        m.insert(key.to_string(), QwenProgress {
            key: key.to_string(), label: label.to_string(), pct: -1.0,
            detail: String::new(),
        });
    }
    Some(JobGuard { app: app.clone(), key: key.to_string() })
}

fn emit(app: &AppHandle, key: &str, label: &str, pct: f64, detail: &str) {
    if let Some(s) = app.try_state::<QwenJobs>() {
        if let Ok(mut m) = s.0.lock() {
            m.insert(key.to_string(), QwenProgress {
                key: key.to_string(), label: label.to_string(), pct,
                detail: detail.to_string(),
            });
            let all: Vec<QwenProgress> = m.values().cloned().collect();
            drop(m);
            let _ = app.emit("qwen://progress", all);
        }
    }
}

#[tauri::command]
pub fn qwen_active(app: AppHandle) -> Vec<QwenProgress> {
    app.try_state::<QwenJobs>()
        .and_then(|s| s.0.lock().ok().map(|m| m.values().cloned().collect()))
        .unwrap_or_default()
}

/* ── layout ──────────────────────────────────────────────────────────────── */

pub fn root_dir(app: &AppHandle) -> PathBuf {
    crate::engine::engine_root(app).join("qwen-tts")
}

/// One directory per checkpoint, named by its SET id — so the two can never
/// be unpacked over each other, which would be a directory that loads and is
/// neither model.
fn weights_dir(app: &AppHandle, set: &str) -> PathBuf {
    root_dir(app).join("weights").join(set)
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

/// The two sets, as (id, repo, rev, files).
fn sets() -> [(&'static str, &'static str, &'static str, &'static [(&'static str, u64)]); 2] {
    [
        (DESIGN_SET_ID, DESIGN_REPO, DESIGN_REV, DESIGN_WEIGHTS),
        (CLONE_SET_ID, CLONE_REPO, CLONE_REV, CLONE_WEIGHTS),
    ]
}

/// Which weight files are still missing across BOTH checkpoints, and how many
/// MB are present. Missing paths are reported `<set>/<rel>` so a half-finished
/// install says WHICH model it is short of.
fn weights_state(app: &AppHandle) -> (u64, u64, Vec<String>) {
    let mut have = 0u64;
    let mut total = 0u64;
    let mut missing = Vec::new();
    for (id, _, _, files) in sets() {
        let dir = weights_dir(app, id);
        for (rel, mb) in files {
            total += mb;
            let p = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if p.is_file() {
                have += mb;
            } else {
                missing.push(format!("{id}/{rel}"));
            }
        }
    }
    (have, total, missing)
}

/// The studio's mirror for ONE set, or None to fall back to HuggingFace.
///
/// Probed per set rather than once, because the two move independently: a
/// mirror that carries the design checkpoint and not Base must serve the one
/// it has rather than refusing both.
async fn mirror_base(cdn: Option<&str>, set_id: &str, rev: &str,
                     files: &[(&str, u64)]) -> Option<String> {
    use tauri_plugin_http::reqwest;
    let base = cdn.map(|c| c.trim_end_matches('/'))?;
    if base.is_empty() {
        return None;
    }
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .ok()?;
    // Cache-busted: the index is the one MUTABLE object under a prefix the CDN
    // holds for 30 days, and reading a stale copy is how a full mirror reads
    // as empty.
    let url = format!("{base}/{SET_PREFIX}index.json?t={}",
                      std::time::SystemTime::now()
                          .duration_since(std::time::UNIX_EPOCH)
                          .map(|d| d.as_secs()).unwrap_or(0));
    let body = c.get(url).send().await.ok()?.text().await.ok()?;
    let doc: serde_json::Value = serde_json::from_str(&body).ok()?;
    let set = doc.get("sets")?.get(set_id)?;
    if set.get("rev")?.as_str()? != rev {
        return None;
    }
    let listed: std::collections::HashSet<&str> = set.get("files")?
        .as_array()?.iter().filter_map(|v| v.as_str()).collect();
    if !files.iter().all(|(rel, _)| listed.contains(rel)) {
        return None;
    }
    Some(format!("{base}/{SET_PREFIX}{set_id}/{rev}"))
}

async fn health() -> bool {
    use tauri_plugin_http::reqwest;
    let Ok(c) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    else {
        return false;
    };
    c.get(format!("{}/health", base_url()))
        .send().await.map(|r| r.status().is_success()).unwrap_or(false)
}

pub async fn is_serving() -> bool {
    health().await
}

/* ── status ──────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn qwen_status(app: AppHandle, proc: State<'_, QwenProc>)
    -> Result<QwenStatus, String>
{
    let root = root_dir(&app);
    let venv = venv_python(&root).is_file();
    let (have, total, missing) = weights_state(&app);
    let reachable = health().await;
    let ours = {
        let mut g = proc.0.lock().map_err(|_| "qwen process lock is poisoned")?;
        match g.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    };
    Ok(QwenStatus {
        installed: venv && missing.is_empty(),
        venv,
        weights_mb: have,
        weights_total_mb: total,
        weights_missing: missing,
        reachable,
        ours,
        starting: ours && !reachable,
        foreign: reachable && !ours,
        device: std::fs::read_to_string(root.join("device.txt"))
            .ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        port: PORT,
        root: root.to_string_lossy().into_owned(),
        license: LICENSE.to_string(),
        supports_direction: false,
    })
}

/* ── install ─────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn install_qwen(
    app: AppHandle, force: Option<bool>, cdn_base: Option<String>,
) -> Result<(), String> {
    let Some(_guard) = claim(&app, "", "Installing Qwen3-TTS") else {
        return Err("Qwen3-TTS is already installing".into());
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
        return Err("Qwen3-TTS needs the studio's Python — take \"Utilities only\" \
                    (or the full install) on the Engine tab first.".into());
    }

    // 2. the venv and its own torch. NEVER THE ENGINE'S: `qwen-tts` pins
    //    transformers==4.57.3 and accelerate==1.12.0 EXACTLY, and the engine
    //    renders on its own stack — sharing one environment means one of the
    //    two is wrong. The cost is ~2GB of duplicate torch, the correct trade
    //    and the fourth instance of the rule.
    let vpy = venv_python(&root);
    if force || !vpy.is_file() {
        emit(&app, "", "Creating the Qwen3-TTS environment", -1.0, "");
        crate::engine::run_python(
            &py, &["-m", "venv", &root.join("venv").to_string_lossy()], &root)?;
    }
    emit(&app, "", "Installing Qwen3-TTS dependencies", -1.0, "a few minutes");
    crate::engine::run_python(
        &vpy, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                "--upgrade", "pip"], &root)?;
    // Windows + an NVIDIA card takes the CUDA index, exactly as the engine's
    // own torch does; everywhere else PyPI carries what this machine can use.
    // NOT flash-attn: the model card's quickstart asks for it unconditionally
    // and on mps or cpu that is an import error at load time, which reads as
    // the model being broken. `qwen_tts_serve._attn` falls back to sdpa.
    let mut targs: Vec<String> = ["-m", "pip", "install", "--disable-pip-version-check",
                                  "-q", "-U", PACKAGE].iter().map(|s| s.to_string()).collect();
    for a in crate::engine::torch_index_args(cfg!(target_os = "windows"),
                                             crate::engine::has_nvidia()) {
        targs.push(a.to_string());
    }
    let refs: Vec<&str> = targs.iter().map(|s| s.as_str()).collect();
    crate::engine::run_python(&vpy, &refs, &root)?;

    // 3. the weights, through the same downloader every model file uses —
    //    resumable, HTML-refusing, and ONE entry in the queue popover per set.
    for (id, repo, rev, files) in sets() {
        let wdir = weights_dir(&app, id);
        let want: Vec<&(&str, u64)> = files.iter()
            .filter(|(rel, _)| !wdir.join(
                rel.replace('/', std::path::MAIN_SEPARATOR_STR)).is_file())
            .collect();
        if want.is_empty() {
            continue;
        }
        let mirror = mirror_base(cdn_base.as_deref(), id, rev, files).await;
        let gb = files.iter().map(|(_, mb)| mb).sum::<u64>() as f64 / 1024.0;
        emit(&app, "", "Downloading the voice weights", -1.0,
             &format!("{gb:.1} GiB from {}",
                      if mirror.is_some() { "the studio's mirror" } else { "HuggingFace" }));
        let set_files: Vec<crate::SetFile> = files.iter().map(|(rel, mb)| crate::SetFile {
            url: match mirror.as_deref() {
                Some(b) => format!("{b}/{rel}"),
                None => format!("https://huggingface.co/{repo}/resolve/{rev}/{rel}"),
            },
            path: (*rel).to_string(),
            size_mb: Some(*mb),
            sha256: None,
        }).collect();
        crate::fetch_file_set(
            app.clone(), format!("qwen-weights-{id}"),
            wdir.to_string_lossy().into_owned(),
            set_files, None, Some("qwen".into())).await?;
    }

    // 4. prove it imports, and record what device it will use. A venv that
    //    installed and cannot import is the failure worth catching HERE, not
    //    at the first line somebody asks for.
    emit(&app, "", "Checking the install", -1.0, "");
    let probe = crate::engine::run_python(&vpy, &["-c",
        "import torch, qwen_tts;\
         mps=getattr(torch.backends,'mps',None);\
         print('cuda' if torch.cuda.is_available() else \
               ('mps' if mps and mps.is_available() else 'cpu'))"], &root)?;
    let _ = std::fs::write(root.join("device.txt"), probe.trim());
    emit(&app, "", "Qwen3-TTS ready", 1.0, probe.trim());
    Ok(())
}

/* ── run ─────────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn start_qwen(app: AppHandle, proc: State<'_, QwenProc>) -> Result<(), String> {
    // WE DO NOT FIGHT FOR THE PORT. Anything already answering is somebody
    // else's server and starting a second one would take a port we do not own
    // and load 9GB beside theirs.
    if health().await {
        return Ok(());
    }
    {
        let mut g = proc.0.lock().map_err(|_| "qwen process lock is poisoned")?;
        if let Some(c) = g.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Ok(());
            }
            *g = None;
        }
    }
    let root = root_dir(&app);
    let vpy = venv_python(&root);
    let design = weights_dir(&app, DESIGN_SET_ID);
    let clone = weights_dir(&app, CLONE_SET_ID);
    if !vpy.is_file() || !design.join("config.json").is_file()
        || !clone.join("config.json").is_file()
    {
        return Err("Qwen3-TTS is not installed on this machine — \
                    install it from the engine window's Speech tab.".into());
    }
    let log = std::fs::File::create(root.join("qwen-tts.log")).map_err(|e| e.to_string())?;
    let errlog = log.try_clone().map_err(|e| e.to_string())?;

    // OUR OWN SERVER. The `qwen-tts` package ships one entry point and it is a
    // Gradio app, so there is nothing upstream to point a URL at;
    // `qwen_tts_serve.py` speaks the wire `qwen_voice.py` reads.
    let shim = crate::planner::worker_dir(&app)?.join("qwen_tts_serve.py");
    let mut cmd = std::process::Command::new(&vpy);
    cmd.arg(&shim)
        // NOT --preload: on the pod the unit pays 9GB up front because a
        // render leg is about to want a line; on a laptop the Start button
        // should come back, and the first line pays for what it uses. A design
        // never loads Base at all this way.
        .current_dir(&root)
        .env("PATH", crate::engine::child_path(&crate::engine::engine_root(&app)))
        .env("QWEN_TTS_HOST", "127.0.0.1")
        .env("QWEN_TTS_PORT", PORT.to_string())
        // BY PATH, never by hub id: a hub id would re-download 4.5GB into the
        // HF cache at render time and would need the network on every start.
        .env("QWEN_TTS_DESIGN_MODEL", &design)
        .env("QWEN_TTS_CLONE_MODEL", &clone)
        // Not every op has an MPS kernel yet; falling back to the CPU for one
        // is a slower line, where refusing is no line at all.
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(errlog));
    let child = crate::hardware::no_window(&mut cmd).spawn().map_err(|e| e.to_string())?;
    *proc.0.lock().map_err(|_| "qwen process lock is poisoned")? = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_qwen(proc: State<'_, QwenProc>) -> Result<(), String> {
    // OUR CHILD ONLY. A server the user started themselves is theirs.
    let mut g = proc.0.lock().map_err(|_| "qwen process lock is poisoned")?;
    if let Some(mut c) = g.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

/// Stop OUR child before a ComfyUI render, and say whether we did.
///
/// QWEN SHARES THE GPU, and holds MORE than Breeze: the pair is ~9GB of
/// weights against Breeze's ~8.5, past the headroom that already killed a
/// 311-frame block on the pod. Every line an episode needs is synthesised at
/// PLAN time, so the service has nothing to do during a render leg. Nothing
/// restarts it here — `qwen_ensure_up` brings it back the moment a line is
/// asked for, so a render leg never pays the load twice.
#[tauri::command]
pub fn qwen_park(proc: State<'_, QwenProc>) -> Result<bool, String> {
    let mut g = proc.0.lock().map_err(|_| "qwen process lock is poisoned")?;
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
pub async fn qwen_ensure_up(
    app: AppHandle, proc: State<'_, QwenProc>, wait_s: Option<u64>,
) -> Result<bool, String> {
    if health().await {
        return Ok(true);
    }
    start_qwen(app.clone(), proc).await?;
    // LONGER than Breeze's default: this loads two checkpoints on demand, and
    // on a laptop off a cold page cache that is minutes rather than seconds.
    let deadline = wait_s.unwrap_or(300);
    for _ in 0..(deadline / 2).max(1) {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if health().await {
            return Ok(true);
        }
    }
    Err("Qwen3-TTS started but never answered — see qwen-tts.log in the \
         engine folder (the Speech tab links it).".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE PAIR IS THE UNIT. A build that shipped one checkpoint would install,
    /// report ready, design a voice and then raise on the first line it tried
    /// to speak in it — `generate_voice_clone` refuses a non-Base checkpoint.
    #[test]
    fn both_checkpoints_are_in_the_set_list() {
        let ids: Vec<&str> = sets().iter().map(|(id, ..)| *id).collect();
        assert!(ids.contains(&DESIGN_SET_ID) && ids.contains(&CLONE_SET_ID));
        assert_ne!(DESIGN_REPO, CLONE_REPO);
        assert_ne!(DESIGN_REV, CLONE_REV);
    }

    /// Each set must carry the transformer AND its own `speech_tokenizer/`
    /// peer — the codec the runtime decodes through. The model alone is a
    /// server that starts and cannot make a sound.
    #[test]
    fn every_set_carries_its_codec() {
        for (id, _, _, files) in sets() {
            let paths: Vec<&str> = files.iter().map(|(p, _)| *p).collect();
            assert!(paths.contains(&"model.safetensors"), "{id} has no transformer");
            assert!(paths.contains(&"speech_tokenizer/model.safetensors"),
                    "{id} has no speech tokenizer");
            assert!(paths.contains(&"config.json"), "{id} has no config");
        }
    }

    /// The port must not be Breeze's: a machine may serve both, and a shared
    /// port makes "already running" answer for the wrong engine — which starts
    /// nothing and reports success.
    #[test]
    fn the_port_is_not_breezes() {
        assert_ne!(PORT, crate::breeze::PORT);
    }

    /// Nine gigabytes, and the status arithmetic has to agree with it.
    #[test]
    fn the_pair_is_about_nine_gigabytes() {
        let total: u64 = sets().iter()
            .flat_map(|(_, _, _, f)| f.iter().map(|(_, mb)| *mb)).sum();
        assert!((8500..9600).contains(&total), "total was {total} MB");
    }
}
