//! Qamba Studio desktop shell.
//!
//! The Rust side is deliberately thin. It owns exactly the three things a
//! webview cannot do for itself — read the hardware, write a multi-gigabyte
//! file to disk, and make an HTTP request that is not bound by CORS — and
//! nothing else. Every screen, every store and every query is the same
//! TypeScript the web build runs, so the desktop app cannot drift into being a
//! second product.
//!
//! NOTE ON THE COMFYUI CONNECTION. There is no `check_comfy_status` command
//! here, though it would be a natural fit: `src/lib/comfyLocal.ts` already
//! reaches the engine through the http plugin, which is Rust-side and
//! therefore CORS-free. A second implementation in this file would be a second
//! place for the timeout, the error text and the "unreachable ≠ absent"
//! distinction to be got wrong.

pub mod breeze;
pub mod qwen;
pub mod datadir;
pub mod dbproxy;
pub mod engine;
pub mod hardware;
pub mod localstore;
pub mod mediaserver;
pub mod ollama;
pub mod planner;
pub mod secrets;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[tauri::command]
fn detect_hardware() -> hardware::HardwareProfile {
    hardware::detect()
}

#[tauri::command]
fn app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    received: u64,
    total: u64,
    done: bool,
}

/// Every download currently in flight, so the UI can find its way back to one.
///
/// WHY THIS EXISTS. A download outlives the screen that started it: closing the
/// engine modal unmounts the React component and its `dl`/`dlFile` state, but
/// the Rust task keeps writing (measured: a `.part` still growing 7MB/4s after
/// the modal was closed). The row then re-read as "absent" and offered Download
/// again — and taking that offer opened a SECOND writer on the same `.part`
/// path, interleaving two streams into one file. The registry makes the
/// in-flight set a question the UI can ask, and makes the duplicate refusable.
#[derive(Default)]
pub struct Downloads(pub std::sync::Mutex<std::collections::HashMap<String, DlEntry>>);

#[derive(Clone, Serialize)]
pub struct DlEntry {
    pub id: String,
    pub received: u64,
    pub total: u64,
    pub dest: String,
    /// Which catalogue row asked for this — `${family}/${variant}`, or an
    /// add-on id. REQUIRED for the engine screen to attribute a resumed
    /// download to one row: a filename cannot do it, because the big shared
    /// files (`umt5_xxl…` is 6.5GB and belongs to every Wan variant) match
    /// every row in the family at once and lit all of them up as
    /// "downloading". `None` for a download nobody claimed.
    pub owner: Option<String>,
}

/// Removes the registry entry however the download ends — `?`, panic or
/// success. Written as a guard rather than a cleanup at the bottom because
/// this function has a dozen early returns and one forgotten path would leave
/// a phantom "already downloading" that only an app restart clears.
struct ActiveGuard {
    app: AppHandle,
    id: String,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Some(state) = self.app.try_state::<Downloads>() {
            if let Ok(mut map) = state.0.lock() {
                map.remove(&self.id);
            }
        }
    }
}

fn note_progress(app: &AppHandle, id: &str, received: u64, total: u64) {
    if let Some(state) = app.try_state::<Downloads>() {
        if let Ok(mut map) = state.0.lock() {
            if let Some(e) = map.get_mut(id) {
                e.received = received;
                e.total = total;
            }
        }
    }
}

/// What is downloading right now. The engine screen seeds itself from this on
/// mount, which is what lets a reopened modal show a live bar instead of a
/// Download button.
#[tauri::command]
fn active_downloads(app: AppHandle) -> Vec<DlEntry> {
    app.try_state::<Downloads>()
        .and_then(|s| s.0.lock().ok().map(|m| m.values().cloned().collect()))
        .unwrap_or_default()
}

/// Stream a file to disk, reporting progress on `download://progress`.
///
/// THREE THINGS THIS DOES THAT A NAIVE DOWNLOAD DOES NOT, each one a failure
/// this codebase has already paid for on the pod side (see
/// the engine window's model list):
///
///   * it writes to `<dest>.part` and renames only on success, so an
///     interrupted 12GB fetch cannot be mistaken for a finished one by the
///     next run;
///   * it refuses an HTML body. Civitai answers a gated download with **200
///     and its web page**, which lands as a valid-looking .safetensors unless
///     the content type is checked;
///   * it verifies SHA256 when the caller knows one, because a truncated
///     checkpoint fails at load time with an error that names the model rather
///     than the download.
#[tauri::command]
async fn download_model_file(
    app: AppHandle,
    id: String,
    url: String,
    dest: String,
    sha256: Option<String>,
    token: Option<String>,
    owner: Option<String>,
) -> Result<String, String> {
    download_one(app, id, url, dest, sha256, token, owner, None).await
}

/// One file of a SET, for the aggregate progress arithmetic.
///
/// `base` is what the set had already written when this file started and
/// `grand` is the set's total, so a twelve-file install shows ONE bar moving
/// once rather than twelve bars each restarting at zero.
#[derive(Clone, Copy)]
struct SetCtx {
    base: u64,
    grand: u64,
}

pub(crate) async fn download_one(
    app: AppHandle,
    id: String,
    url: String,
    dest: String,
    sha256: Option<String>,
    token: Option<String>,
    owner: Option<String>,
    set: Option<SetCtx>,
) -> Result<String, String> {
    use tauri_plugin_http::reqwest;

    let dest = PathBuf::from(&dest);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    // APPEND `.part`, do not replace the extension: `x.gguf.part` maps back to
    // exactly one final filename, where `x.part` could have been a .gguf or a
    // .safetensors — and `engine_status` has to make that mapping to show a
    // resumable download against the right row.
    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    // Anything already downloaded under the OLD name is still worth resuming
    // rather than re-fetching: adopt it before deciding how much we have.
    let legacy = dest.with_extension("part");
    if !part.exists() && legacy.exists() {
        let _ = tokio::fs::rename(&legacy, &part).await;
    }

    // Already on disk in full? Then this is a no-op, not a re-fetch. Reaching
    // here at all means the caller's `installed` set was stale.
    if tokio::fs::metadata(&dest).await.is_ok() {
        // A SET must not report `done` here — twelve files means twelve of
        // these, and the first one would retire the whole install's bar.
        if set.is_none() {
            let _ = app.emit("download://progress",
                DownloadProgress { id, received: 1, total: 1, done: true });
        }
        return Ok(dest.to_string_lossy().into_owned());
    }

    // ONE writer per file. Two concurrent streams into the same `.part` do not
    // fail loudly — they interleave and produce a plausible-sized, corrupt
    // file, which then fails at model-load time naming the model rather than
    // the download.
    //
    // Inside a SET the caller holds the one entry for the whole install, so
    // registering here as well would put a second bar on screen per file and
    // — worse — the guard would retire the set's entry on the first file.
    let _guard = if set.is_none() {
        let state = app.state::<Downloads>();
        {
            let mut map = state.0.lock().map_err(|_| "download registry is poisoned")?;
            if map.contains_key(&id) {
                return Err(format!("{id} is already downloading"));
            }
            map.insert(id.clone(), DlEntry {
                id: id.clone(), received: 0, total: 0,
                dest: dest.to_string_lossy().into_owned(), owner: owner.clone(),
            });
        }
        Some(ActiveGuard { app: app.clone(), id: id.clone() })
    } else {
        None
    };

    // RESUME. A partial `.part` is the normal state after an app restart, and
    // re-fetching from zero throws away however many gigabytes were already
    // written — 1.6GB in the case that prompted this. `Range` asks for the
    // remainder; a server that ignores it answers 200 instead of 206 and the
    // file is restarted, which is handled below rather than assumed away.
    let have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

    // REMEMBER WHO ASKED, on disk beside the bytes. The registry is in memory,
    // so an app restart loses the fact that these gigabytes were fetched for
    // "Wan 2.2 5B Q6_K" — and a resume then has nothing to attribute itself to
    // except the file, which for a SHARED encoder belongs to every variant of
    // three families at once. The sidecar is what lets the row the user
    // actually picked light up again.
    let owner_side = PathBuf::from(format!("{}.owner", part.to_string_lossy()));
    if let Some(o) = owner.as_deref().filter(|o| !o.is_empty()) {
        let _ = tokio::fs::write(&owner_side, o).await;
    }

    let mut req = reqwest::Client::new()
        .get(&url)
        // Civitai 403s the default agent even with a valid token
        .header("user-agent", "QambaStudio/0.1")
        .header("accept", "application/octet-stream");
    if have > 0 {
        req = req.header("range", format!("bytes={have}-"));
    }
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.header("authorization", format!("Bearer {t}"));
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    // 416 means the `.part` is at or past the full length — a download that
    // finished writing but died before the rename. Nothing left to fetch.
    if res.status().as_u16() == 416 && have > 0 {
        tokio::fs::rename(&part, &dest).await.map_err(|e| e.to_string())?;
        let _ = tokio::fs::remove_file(&owner_side).await;
        let _ = app.emit("download://progress",
            DownloadProgress { id, received: have, total: have, done: true });
        return Ok(dest.to_string_lossy().into_owned());
    }
    if !res.status().is_success() {
        return Err(format!("the server answered {}", res.status()));
    }
    let resuming = have > 0 && res.status().as_u16() == 206;
    let ctype = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if ctype.contains("text/html") {
        return Err(
            "the server sent an HTML page instead of a file — the download is gated and needs \
             an API token with access to it"
                .into(),
        );
    }

    // On a 206 the body is only the REMAINDER, so the real total is what is
    // already on disk plus what is coming.
    let total = res.content_length().unwrap_or(0) + if resuming { have } else { 0 };
    let mut file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(&part).await
    } else {
        tokio::fs::File::create(&part).await     // truncates a `.part` we cannot resume
    }
    .map_err(|e| e.to_string())?;

    let mut hasher = Sha256::new();
    let mut received: u64 = if resuming { have } else { 0 };
    // A resumed hash has to cover the bytes this process never saw. Only worth
    // the read when a checksum was actually supplied — otherwise it is a
    // pointless multi-gigabyte pass over the disk.
    if resuming && sha256.as_deref().is_some_and(|s| !s.is_empty()) {
        use tokio::io::AsyncReadExt;
        let mut prior = tokio::fs::File::open(&part).await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        let mut seen = 0u64;
        while seen < have {
            let n = prior.read(&mut buf).await.map_err(|e| e.to_string())?;
            if n == 0 { break; }
            let take = ((have - seen) as usize).min(n);
            hasher.update(&buf[..take]);
            seen += take as u64;
        }
    }
    let mut last_emit: u64 = 0;
    let mut res = res;
    if resuming {
        let _ = app.emit("download://progress",
            DownloadProgress { id: id.clone(), received, total, done: false });
    }

    // `chunk()` rather than `bytes_stream()`: the latter needs reqwest's
    // `stream` feature, and reqwest is not ours to configure — it arrives
    // through tauri-plugin-http, and adding a second direct dependency on it
    // to flip one feature risks two TLS stacks in one binary. This reads the
    // body incrementally just the same, which is the only thing that matters
    // for a file too big to hold in memory.
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("transfer failed after {received} bytes: {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        // one event per megabyte: a 12GB file is ~800k chunks, and emitting on
        // each of them costs more than the download
        if received - last_emit > 1_048_576 {
            last_emit = received;
            // Inside a set the numbers are the SET's, not this file's — one
            // bar that moves once, rather than twelve that each restart.
            let (r, t) = match set {
                Some(s) => (s.base + received, s.grand.max(s.base + received)),
                None => (received, total),
            };
            note_progress(&app, &id, r, t);
            let _ = app.emit("download://progress",
                DownloadProgress { id: id.clone(), received: r, total: t, done: false });
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // A STREAM THAT ENDS EARLY IS NOT A FINISHED DOWNLOAD, and nothing here
    // used to notice. `chunk()` returns None both when the body is complete
    // and when the server closed the connection partway, so a truncated
    // transfer fell straight through to the rename below and became a file
    // the app reports as INSTALLED. The checksum is the only other guard and
    // the browser passes none (`useActiveDownloads` sends id/url/dest/owner),
    // so nothing was checking anything.
    //
    // MEASURED, on this machine: Flux 2 Klein 4B's two files sat in
    // `models/` at 746MB of 3670MB and 806MB of 2484MB, both renamed into
    // place, both dated the same minute. The engine window offered the model,
    // the composer let a render start, and ComfyUI failed it at `CLIPLoader`
    // with `incomplete metadata, file not fully covered` — a safetensors
    // header describing more bytes than the file has. Every layer behaved as
    // designed and the diagnosis needed the ComfyUI log.
    //
    // `content_length` is authoritative for the transfer and is already in
    // hand, so this needs nothing from the caller. THE `.part` IS KEPT: the
    // bytes are a valid PREFIX (HTTP delivers in order), so the existing
    // Range resume finishes it rather than starting the gigabytes again.
    // Absent (chunked encoding) `total` is 0 and this cannot judge, which is
    // the honest answer rather than a guess.
    if total > 0 && received < total {
        return Err(format!(
            "the download ended early — {received} of {total} bytes. \
             The part already fetched is kept; run it again to resume."));
    }

    if let Some(want) = sha256.filter(|s| !s.is_empty()) {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(&want) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("checksum mismatch — expected {want}, got {got}"));
        }
    }

    tokio::fs::rename(&part, &dest).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&owner_side).await;
    if set.is_none() {
        let _ = app.emit("download://progress",
            DownloadProgress { id, received, total: received, done: true });
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// One file of a set, as the browser sends it.
#[derive(Debug, Clone, Deserialize)]
pub struct SetFile {
    pub url: String,
    /// where it goes UNDER `dest_root`, relative and with `/` separators.
    /// Validated by `safe_rel` — it can name a subdirectory (Breeze's
    /// `audio_tokenizer/model.safetensors`), which is the whole reason this
    /// exists beside `download_model_file`.
    pub path: String,
    pub size_mb: Option<u64>,
    pub sha256: Option<String>,
}

/// A relative path is safe to join onto a root we chose.
///
/// The same rule as `localstore::safe_key`, and for the same reason: these
/// come from a catalogue the browser holds, so they are attacker-adjacent in
/// the one way that matters — they are used to build a filesystem path. No
/// absolute paths, no `..`, no backslashes, no drive letters, no dotfiles.
pub fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') || rel.contains("..") {
        return Err(format!("unsafe path '{rel}'"));
    }
    if rel.chars().nth(1) == Some(':') {
        return Err(format!("unsafe path '{rel}'"));
    }
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg.starts_with('.') {
            return Err(format!("unsafe path '{rel}'"));
        }
        out.push(seg);
    }
    Ok(out)
}

/// Download a SET of files under one root, as one entry in the registry.
///
/// `download_model_file` is one file to one path, which is every weight in the
/// catalogue. What it cannot express is a checkpoint that is a DIRECTORY —
/// Breeze TTS 2's twelve files across two levels, or the BigVGAN vocoder
/// MMAudio would otherwise fetch itself on its first render. Those need the
/// same resume, the same HTML refusal and the same registry, and none of the
/// rest of the pipeline (the catalogue's flat filenames, the publisher's
/// `basename`, the status scanner's top-level listing) has anywhere to put a
/// second level.
///
/// ONE registry entry for the whole set, so the queue popover shows one bar
/// for "installing Breeze" rather than twelve; a duplicate set id is refused
/// exactly as a duplicate file is; and a file already complete is skipped, so
/// this resumes an interrupted install at file granularity as well as at byte
/// granularity.
#[tauri::command]
async fn download_file_set(
    app: AppHandle,
    id: String,
    dest_root: String,
    files: Vec<SetFile>,
    token: Option<String>,
    owner: Option<String>,
) -> Result<u64, String> {
    fetch_file_set(app, id, dest_root, files, token, owner).await
}

/// The body of `download_file_set`, callable from inside the crate.
///
/// A `#[tauri::command]` cannot be `pub(crate)` — the attribute generates a
/// macro of its own and re-exporting it collides with itself — so the command
/// stays private and this is what `breeze.rs` calls.
pub(crate) async fn fetch_file_set(
    app: AppHandle,
    id: String,
    dest_root: String,
    files: Vec<SetFile>,
    token: Option<String>,
    owner: Option<String>,
) -> Result<u64, String> {
    let root = PathBuf::from(&dest_root);
    // Validate EVERY path before writing any of them — a set that fails
    // halfway on the ninth file has already written eight.
    let planned: Vec<(PathBuf, &SetFile)> = files
        .iter()
        .map(|f| safe_rel(&f.path).map(|p| (root.join(p), f)))
        .collect::<Result<_, _>>()?;

    let grand: u64 = files.iter().filter_map(|f| f.size_mb).sum::<u64>() * 1_048_576;
    {
        let state = app.state::<Downloads>();
        let mut map = state.0.lock().map_err(|_| "download registry is poisoned")?;
        if map.contains_key(&id) {
            return Err(format!("{id} is already downloading"));
        }
        map.insert(id.clone(), DlEntry {
            id: id.clone(), received: 0, total: grand,
            dest: root.to_string_lossy().into_owned(), owner: owner.clone(),
        });
    }
    let _guard = ActiveGuard { app: app.clone(), id: id.clone() };

    let mut base = 0u64;
    for (dest, f) in planned {
        let already = tokio::fs::metadata(&dest).await.map(|m| m.len()).ok();
        download_one(
            app.clone(), id.clone(), f.url.clone(), dest.to_string_lossy().into_owned(),
            f.sha256.clone(), token.clone(), owner.clone(),
            Some(SetCtx { base, grand }),
        ).await?;
        base += already
            .or_else(|| f.size_mb.map(|mb| mb * 1_048_576))
            .unwrap_or(0);
        note_progress(&app, &id, base, grand.max(base));
    }
    let _ = app.emit("download://progress",
        DownloadProgress { id, received: base, total: grand.max(base), done: true });
    Ok(base)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // FIRST, before any command — `localstore` and `engine` both resolve
        // their roots from `app_data_dir()`, which is keyed on the bundle
        // identifier, so a release that renames the identifier has to carry
        // the previous one's directory across or the user's local projects and
        // their whole downloaded engine are silently orphaned. See datadir.rs.
        // NOTE ON `.setup`: it ASSIGNS the hook rather than appending one, so a
        // second `.setup()` call anywhere below would silently replace this one
        // and orphan every local project on the next identifier change.
        .setup(|app| {
            if let Some(from) = datadir::migrate(app.handle()) {
                println!("[datadir] adopted {} from the previous build", from.display());
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(engine::EngineProc::default())
        .manage(Downloads::default())
        .manage(breeze::BreezeProc::default())
        .manage(breeze::BreezeJobs::default())
        .manage(qwen::QwenProc::default())
        .manage(qwen::QwenJobs::default())
        .manage(ollama::OllamaProc::default())
        .manage(ollama::OllamaJobs::default())
        .manage(dbproxy::DbProxy::default())
        .manage(mediaserver::MediaServer::default())
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            app_data_dir,
            download_model_file,
            download_file_set,
            breeze::breeze_status,
            breeze::breeze_active,
            breeze::install_breeze,
            breeze::start_breeze,
            breeze::stop_breeze,
            breeze::breeze_park,
            breeze::breeze_ensure_up,
            qwen::qwen_status,
            qwen::qwen_active,
            qwen::install_qwen,
            qwen::start_qwen,
            qwen::stop_qwen,
            qwen::qwen_park,
            qwen::qwen_ensure_up,
            active_downloads,
            engine::engine_status,
            engine::install_engine,
            engine::install_utilities,
            engine::start_engine,
            engine::stop_engine,
            engine::engine_log,
            engine::engine_model_path,
            engine::set_linked_comfy,
            engine::pick_comfy_dir,
            engine::open_comfy_window,
            engine::stage_comfy_workflow,
            engine::list_staged_workflows,
            engine::read_staged_workflow,
            localstore::local_store_list,
            localstore::local_store_save,
            localstore::local_store_delete,
            localstore::local_store_root,
            localstore::local_media_write,
            localstore::local_media_delete,
            localstore::local_media_usage,
            localstore::local_media_exists,
            localstore::local_media_list,
            mediaserver::local_media_origin,
            localstore::local_media_upload,
            localstore::local_media_download,
            ollama::ollama_status,
            ollama::ollama_active,
            ollama::install_ollama,
            ollama::start_ollama,
            ollama::stop_ollama,
            ollama::ollama_pull,
            ollama::ollama_remove,
            ollama::ollama_chat,
            secrets::byok_status,
            secrets::byok_set,
            secrets::byok_delete,
            secrets::byok_note_account,
            secrets::byok_fetch,
            planner::planner_ready,
            planner::plan_run,
            planner::desktop_render_models,
            dbproxy::local_db_reply
        ])
        .run(tauri::generate_context!())
        .expect("error while running Qamba Studio");
}

#[cfg(test)]
mod tests {
    use super::safe_rel;

    /// A SET path is attacker-adjacent in the one way that matters: it comes
    /// from a catalogue the browser holds and it is joined onto a root we
    /// chose. `localstore::safe_key`'s rule, for the same reason.
    #[test]
    fn a_set_path_may_name_a_subdirectory_and_nothing_above_the_root() {
        // The case this primitive exists for — Breeze's two-level layout.
        assert_eq!(safe_rel("audio_tokenizer/model.safetensors").unwrap(),
                   std::path::Path::new("audio_tokenizer").join("model.safetensors"));
        assert!(safe_rel("config.json").is_ok());

        for bad in ["../etc/passwd", "/etc/passwd", "a/../../b", "C:\\windows\\x",
                    "a\\b", ".hidden", "a/.hidden", "", "a//b", "a/./b"] {
            assert!(safe_rel(bad).is_err(), "{bad} should have been refused");
        }
    }
}
