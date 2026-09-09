//! A local Ollama the studio installs, owns and runs — the LLM sibling of
//! `engine.rs`, and deliberately its own lifecycle rather than a catalogue row.
//!
//! WHY IT IS NOT AN `engineCatalog` ROW. That catalogue downloads FILES into
//! ComfyUI's model directories (`checkpoints`, `diffusion_models`, …). ComfyUI
//! cannot load an Ollama model and Ollama cannot read a ComfyUI checkpoint:
//! they are two engines with two stores and two wire protocols. A "download
//! Qwen3.8" row over there would fetch 17GB that nothing on the machine could
//! ever load — the "control that cannot reach the render" this codebase keeps
//! naming.
//!
//! WHY IT IS VERSION-GATED, AND WHY THAT IS NOT PEDANTRY. Qwen3.8's chat
//! formatting and tool-call parsing come from a renderer built into the DAEMON
//! (`renderer = qwen3.8`, `parser = qwen3.5` in the model's config), not from
//! the model file. The stock `qwen3.8:27b` manifest declares `requires:
//! 0.32.12` and refuses to pull on anything older with a 412 that names the
//! cause. The abliterated community upload declares NO `requires` — so on an
//! old daemon it pulls happily and then has no renderer to format chat with,
//! falling back to the stub `{{ .Prompt }}` template it ships, which drops the
//! system prompt and every tool signature. That failure is silent. Measured on
//! this developer's own Mac: a system Ollama at 0.23.2, nine minor versions
//! short.
//!
//! WE DO NOT FIGHT FOR THE PORT. If something already answers on 11434 that is
//! the user's own Ollama and we use it, exactly as `engine_status` reports a
//! ComfyUI "started outside the app" rather than trying to own it. Only when
//! nothing is there do we offer to install and run ours.
//!
//! WE DO NOT SET `OLLAMA_MODELS`, on purpose. The pod does (its store is on a
//! separate EBS volume), but here the default `~/.ollama` is SHARED with any
//! Ollama the user already has — so a 17GB model pulled from this screen is
//! visible to their own `ollama` CLI and vice versa. Isolating it would mean
//! downloading the same 17GB twice to the same laptop.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};   // Manager: `try_state`
use tokio::io::AsyncWriteExt;

pub const PORT: u16 = 11434;

/// The daemon version that first carries the qwen3.8 renderer. See the module
/// note: below this, the abliterated build loads and misbehaves silently.
pub const MIN_VERSION: &str = "0.32.12";

/// Pinned, like `PY_URL` and `COMFY_URL` next door: an install that silently
/// changes daemon version between two users is not reproducible.
const OLLAMA_VERSION: &str = "0.32.15";
#[cfg(target_os = "macos")]
const OLLAMA_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.32.15/ollama-darwin.tgz";
#[cfg(target_os = "windows")]
const OLLAMA_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.32.15/ollama-windows-amd64.zip";
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const OLLAMA_URL: &str =
    "https://github.com/ollama/ollama/releases/download/v0.32.15/ollama-linux-amd64.tar.zst";

#[derive(Clone, Serialize)]
pub struct OllamaProgress {
    /// what is happening, in the daemon's own words where it has them
    pub label: String,
    /// 0.0..=1.0, or -1 when the step has no measurable size
    pub pct: f64,
    pub detail: String,
    /// set on a pull so a UI with several rows knows which one moved
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaModel {
    pub name: String,
    pub size_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaStatus {
    /// our own binary is on disk (whether or not it is the one running)
    pub bundled: bool,
    pub bin: Option<String>,
    /// something answers on the port
    pub reachable: bool,
    /// WE started the daemon that is running
    pub ours: bool,
    /// something else holds the port — the user's own Ollama.app or CLI
    pub foreign: bool,
    /// version of whatever answers, else of our binary on disk
    pub version: Option<String>,
    /// OUR binary's own version, whoever currently holds the port. Separate
    /// because installing a newer one while the user's old daemon is running
    /// changes nothing the `version` field can show — and a button that
    /// reports no change reads as a button that did not work.
    pub bundled_version: Option<String>,
    pub bundled_version_ok: bool,
    /// that version is >= MIN_VERSION. False is a REASON, not a warning: the
    /// abliterated model will load and quietly misformat every turn.
    pub version_ok: bool,
    pub min_version: String,
    pub models: Vec<OllamaModel>,
    pub port: u16,
    pub root: String,
}

/// What is in flight right now, keyed by target: `""` for the daemon install,
/// the model tag for a pull.
///
/// WHY THIS EXISTS, and it is not theoretical — it was found by using the app.
/// A 154MB install (or a 17GB pull) OUTLIVES the screen that started it: the
/// modal unmounts, its React state goes with it, the Rust task keeps writing,
/// and on reopen the row reads "not installed" and offers Install again.
/// Taking that offer starts a SECOND download over the same path. Exactly the
/// failure `Downloads` already exists to prevent for weight files, one engine
/// over — so it gets the same shape: a registry the UI can ask, and a refusal
/// that makes the duplicate impossible even if some future surface offers it.
#[derive(Default)]
pub struct OllamaJobs(pub Mutex<std::collections::HashMap<String, OllamaProgress>>);

/// Removes the entry however the function leaves — a guard rather than a
/// cleanup at the bottom, because `install_ollama` has half a dozen `?` early
/// returns and one missed path leaves a phantom "already running" that only an
/// app restart clears. Same reasoning as `ActiveGuard` in lib.rs.
struct JobGuard {
    app: AppHandle,
    key: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<OllamaJobs>() {
            if let Ok(mut m) = state.0.lock() {
                m.remove(&self.key);
            }
        }
    }
}

/// Claim a key, or report that it is already taken. `None` means someone else
/// is already doing this exact thing.
fn claim(app: &AppHandle, key: &str, label: &str) -> Option<JobGuard> {
    let state = app.try_state::<OllamaJobs>()?;
    let mut m = state.0.lock().ok()?;
    if m.contains_key(key) {
        return None;
    }
    m.insert(
        key.to_string(),
        OllamaProgress { label: label.into(), pct: -1.0, detail: String::new(), model: key.into() },
    );
    Some(JobGuard { app: app.clone(), key: key.to_string() })
}

/// What the UI adopts on mount. Without it, reopening the screen mid-download
/// shows a Get button for something already 40% fetched.
#[tauri::command]
pub fn ollama_active(app: AppHandle) -> Vec<OllamaProgress> {
    app.try_state::<OllamaJobs>()
        .and_then(|s| s.0.lock().ok().map(|m| m.values().cloned().collect()))
        .unwrap_or_default()
}

pub struct OllamaProc(pub Mutex<Option<std::process::Child>>);

impl Default for OllamaProc {
    fn default() -> Self {
        OllamaProc(Mutex::new(None))
    }
}

fn root_dir(app: &AppHandle) -> PathBuf {
    crate::engine::engine_root(app).join("ollama")
}

fn bin_path(app: &AppHandle) -> PathBuf {
    let d = root_dir(app).join("bin");
    if cfg!(target_os = "windows") {
        d.join("ollama.exe")
    } else {
        d.join("ollama")
    }
}

fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// `1.2.3` -> (1,2,3), missing parts zero. Anything unparseable sorts LOW, so
/// a version string we do not understand fails the gate rather than passing
/// it — the failure this gate prevents is silent, so erring open is worse.
fn ver_tuple(v: &str) -> (u32, u32, u32) {
    let core = v.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or("");
    let mut it = core.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

pub fn version_ok(v: &str) -> bool {
    ver_tuple(v) >= ver_tuple(MIN_VERSION)
}

/// Ask the daemon. Short timeouts throughout: this is called to paint a screen,
/// and a dead port must answer "no" in milliseconds rather than hanging the UI.
async fn get_json(path: &str) -> Option<serde_json::Value> {
    use tauri_plugin_http::reqwest;
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .ok()?;
    let r = c.get(format!("{}{path}", base_url())).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    // `.json()` is not available here — tauri-plugin-http re-exports reqwest
    // WITHOUT its `json` feature, because engine.rs only ever streams bytes.
    // Same reason every POST below hand-builds its body.
    serde_json::from_str(&r.text().await.ok()?).ok()
}

#[tauri::command]
pub async fn ollama_status(app: AppHandle, proc: State<'_, OllamaProc>) -> Result<OllamaStatus, String> {
    let bin = bin_path(&app);
    let bundled = bin.is_file();

    // Did WE start it? Ask our own child first — `try_wait` is the only
    // honest answer to "ours", the same test `engine_status` makes.
    let ours_alive = {
        let mut guard = proc.0.lock().unwrap();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    };

    let ver_json = get_json("/api/version").await;
    let reachable = ver_json.is_some();
    let version = ver_json
        .as_ref()
        .and_then(|v| v.get("version"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut models = Vec::new();
    if reachable {
        if let Some(tags) = get_json("/api/tags").await {
            if let Some(arr) = tags.get("models").and_then(|m| m.as_array()) {
                for m in arr {
                    let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let size = m.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    if !name.is_empty() {
                        models.push(OllamaModel { name, size_mb: size / 1_048_576 });
                    }
                }
            }
        }
    }

    // With nothing on the port, report OUR binary's version so the screen can
    // say what starting it would give you rather than a blank.
    let version = match (&version, bundled) {
        (Some(_), _) => version.clone(),
        (None, true) => bin_version(&bin),
        _ => None,
    };
    // Both computed before the `version_ok` BINDING below, which would
    // otherwise shadow the function of the same name.
    let bundled_version = bundled.then(|| bin_version(&bin)).flatten();
    let bundled_version_ok = bundled_version.as_deref().map(version_ok).unwrap_or(false);
    let version_ok = version.as_deref().map(version_ok).unwrap_or(false);

    Ok(OllamaStatus {
        bundled,
        bundled_version,
        bundled_version_ok,
        bin: bundled.then(|| bin.to_string_lossy().into_owned()),
        reachable,
        ours: ours_alive && reachable,
        foreign: reachable && !ours_alive,
        version,
        version_ok,
        min_version: MIN_VERSION.into(),
        models,
        port: PORT,
        root: root_dir(&app).to_string_lossy().into_owned(),
    })
}

/// Pull the CLIENT's version out of `ollama --version`.
///
/// THIS IS NOT THE OBVIOUS PARSE, and the obvious one is wrong in exactly the
/// case this whole feature is for. `ollama --version` CONTACTS A SERVER, and
/// prints the SERVER's version first:
///
/// ```text
/// ollama version is 0.23.2            <- whatever daemon it reached
/// Warning: client version is 0.32.15  <- the binary we actually asked
/// ```
///
/// So with the user's old daemon on the port, reading the first number reports
/// our brand-new binary as 0.23.2 — and the screen would offer "Install a
/// newer Ollama" forever, re-downloading on every press and never reaching
/// "Use the newer one". Both lines also go to STDERR, with stdout EMPTY, so
/// reading stdout alone yields nothing at all.
fn parse_version(text: &str) -> Option<String> {
    // The client line is definitive: it is this binary talking about itself.
    for line in text.lines() {
        if let Some(rest) = line.split("client version is").nth(1) {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    // Only printed when there is no server to disagree with, in which case it
    // IS the client's own version.
    for line in text.lines() {
        if let Some(rest) = line.split("version is").nth(1) {
            let v = rest.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn bin_version(bin: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version")
        // Point it at a port nothing listens on so it cannot reach a daemon
        // and reports only itself. Belt to the parser's braces, and it also
        // saves a round trip to a real server just to read a version.
        .env("OLLAMA_HOST", "127.0.0.1:1");
    let out = crate::hardware::no_window(&mut cmd).output().ok()?;
    // BOTH streams: ollama writes its version banner to stderr.
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    parse_version(&text)
}

fn emit(app: &AppHandle, label: &str, pct: f64, detail: &str, model: &str) {
    let p = OllamaProgress {
        label: label.into(),
        pct,
        detail: detail.into(),
        model: model.into(),
    };
    // Into the registry as well as onto the wire: an event only reaches a
    // screen that is already listening, and the whole point here is the screen
    // that was closed when it fired.
    if let Some(state) = app.try_state::<OllamaJobs>() {
        if let Ok(mut m) = state.0.lock() {
            if let Some(e) = m.get_mut(model) {
                *e = p.clone();
            }
        }
    }
    let _ = app.emit("ollama://progress", p);
}

/// Unpack with the OS `tar`, which on both macOS and Windows 10+ is bsdtar and
/// reads zip as readily as gzip — so one code path covers `.tgz` and `.zip`.
/// `-xf` rather than engine.rs's `-xzf` for exactly that reason: `-z` would
/// refuse the Windows asset.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xf").arg(archive).arg("-C").arg(into);
    let out = crate::hardware::no_window(&mut cmd)
        .output()
        .map_err(|e| format!("tar failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "unpacking {}: {}",
            archive.file_name().unwrap_or_default().to_string_lossy(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

async fn download_to(app: &AppHandle, url: &str, dest: &Path, label: &str) -> Result<(), String> {
    use tauri_plugin_http::reqwest;
    let res = reqwest::Client::new()
        .get(url)
        .header("user-agent", "QambaStudio/0.1")
        .send()
        .await
        .map_err(|e| format!("{label}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{label}: server answered {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let (mut got, mut last) = (0u64, 0u64);
    let mut res = res;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("{label}: {e}"))? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if got - last > 2_000_000 {
            last = got;
            emit(
                app,
                label,
                if total > 0 { got as f64 / total as f64 } else { -1.0 },
                &format!("{:.0} MB", got as f64 / 1_048_576.0),
                "",
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Install, or with `force` re-download over what is already there.
///
/// UPDATE IS THE SAME FOUR STEPS, so it is the same command with a flag. Note
/// what it can and cannot do: it replaces OUR copy, never the user's — an
/// Ollama.app in /Applications or a Homebrew install is theirs to update, and
/// reaching into either from here would be modifying a system this app does
/// not own. When theirs holds the port, a forced install still helps: it puts
/// a current daemon on disk, and the screen can then say to quit theirs and
/// press Start.
#[tauri::command]
pub async fn install_ollama(
    app: AppHandle,
    proc: State<'_, OllamaProc>,
    force: Option<bool>,
) -> Result<OllamaStatus, String> {
    // Refuse a second install of the same thing rather than opening a second
    // writer on one path.
    let _guard = match claim(&app, "", "Downloading Ollama") {
        Some(g) => g,
        None => return Err("Ollama is already being installed — that download is still running".into()),
    };
    let bin = bin_path(&app);
    if force.unwrap_or(false) && bin.is_file() {
        std::fs::remove_file(&bin).map_err(|e| format!("could not replace the old binary: {e}"))?;
    }
    if !bin.is_file() {
        let root = root_dir(&app);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let archive = root.join(if cfg!(target_os = "windows") {
            "ollama.zip"
        } else {
            "ollama.tgz"
        });
        emit(&app, "Downloading Ollama", -1.0, OLLAMA_VERSION, "");
        download_to(&app, OLLAMA_URL, &archive, "Downloading Ollama").await?;
        emit(&app, "Unpacking Ollama", -1.0, "", "");
        unpack(&archive, &root.join("bin"))?;
        let _ = std::fs::remove_file(&archive);

        // NOT a bare binary on either platform — a ranged probe of the first
        // 3MB of `ollama-darwin.tgz` lists only `ollama` and reads like one,
        // but the real archive is a 37-file RUNTIME: the 68MB executable plus
        // libggml/libllama dylibs and the mlx_metal_v3/v4 backends it loads
        // beside itself. They all land in `bin/` together, which is what makes
        // the executable work from there. Find the binary rather than assuming
        // a layout.
        if !bin.is_file() {
            if let Some(found) = find_binary(&root.join("bin")) {
                std::fs::create_dir_all(bin.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::rename(&found, &bin).map_err(|e| e.to_string())?;
            }
        }
        #[cfg(unix)]
        if bin.is_file() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
    }
    if !bin.is_file() {
        return Err("the Ollama archive did not contain a binary where we expected one".into());
    }
    let v = bin_version(&bin).unwrap_or_default();
    emit(&app, "Ollama ready", 1.0, &v, "");
    ollama_status(app.clone(), proc).await
}

/// Depth-limited hunt for the executable inside an unpacked tree.
fn find_binary(dir: &Path) -> Option<PathBuf> {
    let want = if cfg!(target_os = "windows") { "ollama.exe" } else { "ollama" };
    let mut stack = vec![(dir.to_path_buf(), 0u8)];
    while let Some((d, depth)) = stack.pop() {
        if depth > 3 {
            continue;
        }
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push((p, depth + 1));
            } else if p.file_name().map(|n| n == want).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn start_ollama(app: AppHandle, proc: State<'_, OllamaProc>) -> Result<OllamaStatus, String> {
    // Never race a daemon that is already there — it is the user's, and two
    // Ollamas cannot share the port anyway.
    if get_json("/api/version").await.is_some() {
        return ollama_status(app.clone(), proc).await;
    }
    // Decide inside the block and act outside it: holding the MutexGuard
    // across the `return` borrows `proc` while the call wants to move it.
    let already_ours = {
        let mut guard = proc.0.lock().unwrap();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    };
    if already_ours {
        return ollama_status(app.clone(), proc).await;
    }
    let bin = bin_path(&app);
    if !bin.is_file() {
        return Err("Ollama is not installed yet".into());
    }
    let root = root_dir(&app);
    let log = std::fs::File::create(root.join("ollama.log")).map_err(|e| e.to_string())?;
    let errlog = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("serve")
        // Loopback only, and for the same reason ComfyUI is: an
        // unauthenticated inference API has no business on the network.
        .env("OLLAMA_HOST", format!("127.0.0.1:{PORT}"))
        // One at a time. A 17GB judge loading beside a 17GB director on a
        // laptop is the swap-to-death the pod avoids with the same setting.
        .env("OLLAMA_MAX_LOADED_MODELS", "1")
        .current_dir(&root)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog));
    let child = crate::hardware::no_window(&mut cmd)
        .spawn()
        .map_err(|e| format!("could not start Ollama: {e}"))?;
    *proc.0.lock().unwrap() = Some(child);

    // Serve binds in well under a second, but returning before it does makes
    // the screen paint "not running" on the tick right after the user pressed
    // Start, which reads as a failed button.
    for _ in 0..20 {
        if get_json("/api/version").await.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    ollama_status(app.clone(), proc).await
}

#[tauri::command]
pub async fn stop_ollama(app: AppHandle, proc: State<'_, OllamaProc>) -> Result<OllamaStatus, String> {
    // Only ever our own child. Killing a daemon the user started themselves
    // would take their Ollama.app down with it.
    let child = proc.0.lock().unwrap().take();
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    ollama_status(app.clone(), proc).await
}

/// Pull a model, streaming the daemon's own progress out as events.
///
/// Through Rust rather than from the webview because a pull is a 17GB transfer
/// that must survive the screen being closed — the same lesson `Downloads`
/// learned for weight files, where a closed modal left a `.part` growing with
/// nothing watching it.
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, model: String) -> Result<(), String> {
    use tauri_plugin_http::reqwest;
    let _guard = match claim(&app, &model, "pulling") {
        Some(g) => g,
        None => return Err(format!("{model} is already downloading")),
    };
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = c
        .post(format!("{}/api/pull", base_url()))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "model": model, "stream": true }).to_string())
        .send()
        .await
        .map_err(|e| format!("pull {model}: {e}"))?;
    if !res.status().is_success() {
        let code = res.status();
        let body = res.text().await.unwrap_or_default();
        // 412 is the daemon saying it is too old for this manifest, and it
        // names the cause plainly — pass it through rather than flattening it
        // to "pull failed".
        return Err(format!("pull {model}: {code} {}", body.trim()));
    }

    let mut buf = String::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("pull {model}: {e}"))? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // NDJSON: one status object per line, and the last line of a chunk is
        // routinely a partial one — keep it for the next round.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf = buf[nl + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(format!("pull {model}: {err}"));
            }
            let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let done = v.get("completed").and_then(|c| c.as_u64()).unwrap_or(0);
            let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
            emit(
                &app,
                status,
                if total > 0 { done as f64 / total as f64 } else { -1.0 },
                &if total > 0 {
                    format!(
                        "{:.1} / {:.1} GB",
                        done as f64 / 1e9,
                        total as f64 / 1e9
                    )
                } else {
                    String::new()
                },
                &model,
            );
        }
    }
    emit(&app, "ready", 1.0, "", &model);
    Ok(())
}

/// Delete a model. Offered because the alternative is telling someone to open
/// a terminal to reclaim 17GB from a screen that spent it.
#[tauri::command]
pub async fn ollama_remove(model: String) -> Result<(), String> {
    use tauri_plugin_http::reqwest;
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let r = c
        .delete(format!("{}/api/delete", base_url()))
        .header("content-type", "application/json")
        .body(serde_json::json!({ "model": model }).to_string())
        .send()
        .await
        .map_err(|e| format!("remove {model}: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("remove {model}: {}", r.status()));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ChatReq {
    pub system: String,
    pub messages: Vec<serde_json::Value>,
    pub model: String,
    /// Ollama tool definitions. Present for a director turn, absent for a
    /// one-shot rewrite — and it must stay ABSENT rather than empty there:
    /// handing a model an empty tool array is not the same as handing it none.
    pub tools: Option<Vec<serde_json::Value>>,
}

/// One non-streaming chat turn against the local daemon.
///
/// Returns the whole `message` object rather than its text, because a director
/// turn needs `tool_calls` and a rewrite needs `content` — one command, and the
/// caller takes the half it wants.
///
/// It goes through Rust for the same reason `comfyLocal` does: the webview's
/// origin is `tauri://localhost`, Ollama sends no CORS headers, and a browser
/// fetch would die in preflight before the daemon saw it.
///
/// `think: false` is not optional and not a preference. Ollama's own
/// ChatHandler sets `req.Think = true` whenever the request omits it and the
/// model declares the capability — so saying nothing is opting IN. On qwen3.8
/// that routes the reply into a separate `thinking` field and leaves `content`
/// EMPTY, which the reviewer measured live on the pod (six in one batch) and
/// which here would read as a director that answered with a blank message.
/// `worker/llm.py` sends the same flag for the same reason; keep them in step.
#[tauri::command]
pub async fn ollama_chat(req: ChatReq) -> Result<serde_json::Value, String> {
    use tauri_plugin_http::reqwest;
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    let mut msgs = vec![serde_json::json!({ "role": "system", "content": req.system })];
    msgs.extend(req.messages);
    let mut body = serde_json::json!({
        "model": req.model,
        "stream": false,
        "think": false,
        "messages": msgs,
    });
    if let Some(tools) = req.tools {
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools);
        }
    }
    let r = c
        .post(format!("{}/api/chat", base_url()))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("ollama: {e}"))?;
    if !r.status().is_success() {
        let code = r.status();
        let body = r.text().await.unwrap_or_default();
        return Err(format!("ollama {code}: {}", body.trim()));
    }
    let text = r.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut msg = v.get("message").cloned().unwrap_or_default();
    // `think: false` should keep the reply in `content`; a build that ignores
    // it puts everything in `thinking` and leaves `content` empty. Fold it
    // back so no caller has to know — the same fallback `llm._ollama_text`
    // keeps. Only when there are no tool_calls: an empty `content` beside a
    // tool call is NORMAL, and pasting reasoning in there would make the
    // assistant turn argue with its own call.
    let has_calls = msg
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    let empty = msg
        .get("content")
        .and_then(|c| c.as_str())
        .map(|c| c.trim().is_empty())
        .unwrap_or(true);
    if empty && !has_calls {
        if let Some(thought) = msg.get("thinking").and_then(|t| t.as_str()).map(String::from) {
            msg["content"] = serde_json::Value::String(thought);
        }
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_gate_is_the_daemon_that_first_carries_the_qwen38_renderer() {
        assert!(version_ok("0.32.12"));
        assert!(version_ok("0.32.15"));
        assert!(version_ok("1.0.0"));
        // The version measured on this developer's Mac — nine minors short,
        // and the reason the gate exists at all.
        assert!(!version_ok("0.23.2"));
        assert!(!version_ok("0.32.6"));
    }

    #[test]
    fn a_version_we_cannot_parse_fails_the_gate_rather_than_passing_it() {
        // Erring open here means pulling a model that loads and then silently
        // misformats every turn, which is the failure the gate exists for.
        assert!(!version_ok(""));
        assert!(!version_ok("unknown"));
    }

    #[test]
    fn the_client_version_wins_over_the_server_it_happened_to_reach() {
        // Verbatim from this developer's Mac, where a 0.23.2 daemon was
        // running while our freshly installed 0.32.15 binary was asked. The
        // naive parse reports 0.23.2 and the screen then offers to install a
        // newer Ollama forever.
        let real = "ollama version is 0.23.2\nWarning: client version is 0.32.15";
        assert_eq!(parse_version(real).as_deref(), Some("0.32.15"));
        assert!(version_ok(&parse_version(real).unwrap()));
    }

    #[test]
    fn with_no_server_to_reach_the_only_version_printed_is_the_clients() {
        let alone = "Warning: could not connect to a running Ollama instance\n\
                     Warning: client version is 0.32.15";
        assert_eq!(parse_version(alone).as_deref(), Some("0.32.15"));
    }

    #[test]
    fn a_plain_banner_still_parses_and_junk_yields_nothing() {
        assert_eq!(parse_version("ollama version is 0.32.15").as_deref(), Some("0.32.15"));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("command not found"), None);
    }

    #[test]
    fn a_v_prefix_and_a_prerelease_suffix_both_parse() {
        assert!(version_ok("v0.32.15"));
        assert!(version_ok("0.33.0-rc1"));
    }
}
