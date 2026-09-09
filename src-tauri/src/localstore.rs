//! Where a LOCAL project lives on disk.
//!
//! The rest of the local plane is TypeScript — the store, the query shim and
//! the sync are all in `src/lib/local*.ts`, and they run under `node --test`
//! precisely because they are. This file owns the two things a webview cannot
//! do for itself, which is the same rule the rest of this crate follows:
//! durable files, and an HTTP request that is not bound by CORS.
//!
//! LAYOUT. One directory per project under `<app data>/local`:
//!
//! ```text
//! local/<project-id>/project.json      every row of that project
//! local/<project-id>/media/<b2 key>    the bytes those rows point at
//! ```
//!
//! `b2_key` is kept EXACTLY as the cloud plane would have written it
//! (`images/<uuid>.png`), so syncing a project up is a copy rather than a
//! rewrite of every row that names a key.
//!
//! THE KEY IS ATTACKER-ADJACENT DATA and is treated as such — it can arrive
//! from an imported project file or from a cloud row somebody else wrote, and
//! it is used to build a path. `safe_key` is the whole defence: no absolute
//! paths, no `..`, no backslashes, no drive letters, nothing outside the
//! project's own media directory. It is unit-tested, because a path traversal
//! here writes anywhere the user can write.
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

/// A project's rows as they sit on disk, plus the id taken from the directory
/// name — the browser parses the JSON, so nothing here needs to understand it.
#[derive(Serialize)]
pub struct StoredProject {
    pub id: String,
    pub json: String,
    /// bytes of media on disk, so the UI can say what a project costs without
    /// a second walk of the tree
    pub media_bytes: u64,
}

#[derive(Serialize)]
pub struct MediaUsage {
    pub bytes: u64,
    pub files: u64,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A project id from the browser. Ids are generated as uuids, so anything that
/// is not uuid-shaped is not one of ours and does not get to name a directory.
fn safe_id(id: &str) -> Result<&str, String> {
    let ok = id.len() == 36
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err(format!("not a project id: {id:?}"))
    }
}

/// A media key from the browser -> a relative path inside the project's media
/// directory, or an error. Deliberately strict: this app only ever writes keys
/// it generated (`images/<uuid>.png`, `audio/lines/<sha>.mp3`), so anything
/// exotic is a bug or an attack and neither should be honoured.
pub fn safe_key(key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || key.len() > 512 {
        return Err("media key is empty or too long".into());
    }
    if key.starts_with('/') || key.contains('\\') || key.contains("://") || key.contains(':') {
        return Err(format!("unsafe media key: {key:?}"));
    }
    let mut out = PathBuf::new();
    for part in key.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.starts_with('.') {
            return Err(format!("unsafe media key: {key:?}"));
        }
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(format!("unsafe media key: {key:?}"));
        }
        out.push(part);
    }
    Ok(out)
}

fn project_dir(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    Ok(root(app)?.join(safe_id(project_id)?))
}

fn media_path(app: &AppHandle, project_id: &str, key: &str) -> Result<PathBuf, String> {
    Ok(media_root(app, project_id)?.join(safe_key(key)?))
}

/// Where one local project's media lives.
///
/// `pub(crate)` because the PIPELINE needs it too: `plan_run` hands it to the
/// child as `QAMBA_MEDIA_ROOT` and `media.py` turns every `b2_put`/`b2_get`
/// into a file operation under it. Derived HERE rather than rebuilt in
/// TypeScript, so the path shape has exactly one owner — a webview that
/// assembled `<root>/<id>/media` itself would go on doing it after this file
/// changed, and the symptom would be renders written where nothing looks.
pub(crate) fn media_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(app, project_id)?.join("media"))
}

/// Total bytes under a directory. Best effort: a file that vanishes mid-walk
/// is simply not counted, because this only ever feeds a "how big is this"
/// readout and must never be the reason an operation fails.
fn dir_bytes(dir: &Path) -> (u64, u64) {
    let mut bytes = 0;
    let mut files = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    (bytes, files)
}

/* ── rows ───────────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn local_store_list(app: AppHandle) -> Result<Vec<StoredProject>, String> {
    let dir = root(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if safe_id(&id).is_err() {
            continue;
        }
        let file = entry.path().join("project.json");
        // A project whose file is unreadable is REPORTED by its absence from
        // this list and a log line, never by a failed startup: one damaged
        // project must not cost the user the others.
        match std::fs::read_to_string(&file) {
            Ok(json) => {
                let (media_bytes, _) = dir_bytes(&entry.path().join("media"));
                out.push(StoredProject { id, json, media_bytes });
            }
            Err(e) => eprintln!("[local] project {id} is unreadable: {e}"),
        }
    }
    Ok(out)
}

/// Write a project's rows. ATOMIC — a temp file in the same directory, then a
/// rename, which is what stops a crash mid-write leaving a half-written
/// project.json that no build can parse. The previous good file survives until
/// the rename lands.
///
/// IT TAKES THE DOCUMENT AS BYTES, not as a `String` argument, and that is a
/// cost decision rather than a style one. A named `json: String` argument is
/// carried inside the IPC's own JSON envelope, so an 11MB project — measured,
/// on a real one — is escaped to roughly 22MB on the way out and then
/// `serde_json`-parsed back here, on the MAIN THREAD, which is also the
/// thread answering `asset://` for whatever the player is trying to decode.
/// A raw body is the same bytes at both ends and is written unparsed.
///
/// The project id rides in a header because a raw body leaves nowhere else
/// for it: `safe_id` still decides whether it may name a directory.
#[tauri::command]
pub async fn local_store_save(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let (project_id, bytes) = save_target(request.headers(), request.body())?;
    write_project(&project_dir(&app, &project_id)?, &bytes).await
}

/// What one raw invoke MEANS — apart from the command so it can be tested,
/// since `tauri::ipc::Request` cannot be built outside tauri and the mock
/// runtime's ACL denies an app command outright.
///
/// The bytes are CLONED out of the body so nothing is borrowed across the
/// write: an 11MB memcpy, against the ~22MB escape and parse this whole shape
/// exists to remove.
fn save_target(
    headers: &tauri::http::HeaderMap,
    body: &InvokeBody,
) -> Result<(String, Vec<u8>), String> {
    let project_id = headers
        .get("qamba-project")
        .and_then(|v| v.to_str().ok())
        .ok_or("local_store_save needs a qamba-project header")?
        .to_owned();
    match body {
        InvokeBody::Raw(b) => Ok((project_id, b.clone())),
        // The two sides ship together, so this can only be a half-rolled-back
        // build — and writing nothing while reporting success would be the
        // worst possible answer to that.
        InvokeBody::Json(_) => Err("local_store_save expects the document as raw bytes".into()),
    }
}

/// The atomic write. Temp file in the same directory, fsync, rename.
async fn write_project(dir: &Path, bytes: &[u8]) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let tmp = dir.join("project.json.tmp");
    let dest = dir.join("project.json");
    let mut f = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    f.write_all(bytes).await.map_err(|e| e.to_string())?;
    f.flush().await.map_err(|e| e.to_string())?;
    // fsync before the rename: on a crash, a renamed-but-unflushed file is an
    // empty project rather than the previous one.
    f.sync_all().await.map_err(|e| e.to_string())?;
    drop(f);
    tokio::fs::rename(&tmp, &dest).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_store_delete(app: AppHandle, project_id: String) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Where the local plane keeps everything — the browser needs this to build an
/// `asset://` URL for a media file, which is a string operation it can do
/// synchronously once it knows the root.
#[tauri::command]
pub fn local_store_root(app: AppHandle) -> Result<String, String> {
    Ok(root(&app)?.to_string_lossy().into_owned())
}

/* ── media ──────────────────────────────────────────────────────────────── */

/// Append (or start) a media file from base64. Chunked by the caller, because
/// a render's mp4 does not belong in one IPC message.
#[tauri::command]
pub async fn local_media_write(
    app: AppHandle,
    project_id: String,
    key: String,
    data: String,
    append: bool,
) -> Result<u64, String> {
    let path = media_path(&app, &project_id, &key)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let bytes = STANDARD.decode(data.as_bytes()).map_err(|e| e.to_string())?;
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(append)
        .write(true)
        .truncate(!append)
        .open(&path)
        .await
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).await.map_err(|e| e.to_string())?;
    f.flush().await.map_err(|e| e.to_string())?;
    let len = f.metadata().await.map(|m| m.len()).unwrap_or(bytes.len() as u64);
    Ok(len)
}

#[tauri::command]
pub async fn local_media_delete(
    app: AppHandle,
    project_id: String,
    keys: Vec<String>,
) -> Result<u64, String> {
    let mut gone = 0;
    for key in keys {
        let Ok(path) = media_path(&app, &project_id, &key) else { continue };
        if tokio::fs::remove_file(&path).await.is_ok() {
            gone += 1;
        }
    }
    Ok(gone)
}

#[tauri::command]
pub fn local_media_usage(app: AppHandle, project_id: String) -> Result<MediaUsage, String> {
    let (bytes, files) = dir_bytes(&project_dir(&app, &project_id)?.join("media"));
    Ok(MediaUsage { bytes, files })
}

#[tauri::command]
pub fn local_media_exists(app: AppHandle, project_id: String, key: String) -> Result<bool, String> {
    Ok(media_path(&app, &project_id, &key)?.exists())
}

/// Every media KEY a local project holds on disk, as relative paths.
///
/// This is what lets the plane answer "is this file actually here" without a
/// stat per resolution: `localMediaUrl` is synchronous and called from render
/// paths, so the answer has to come from a set seeded once and maintained —
/// and the seed is this walk. Without it a key any ROW names resolved to an
/// `asset://` path unconditionally, and a partially-pulled project's missing
/// two-thirds each 404'd instead of falling through to the CDN copy the pull
/// deliberately left in the bucket.
///
/// `.part`/`.tmp` are skipped for `local_media_download`'s reason: a
/// half-written file must never be counted as present.
#[tauri::command]
pub fn local_media_list(app: AppHandle, project_id: String) -> Result<Vec<String>, String> {
    Ok(walk_media(&project_dir(&app, &project_id)?.join("media")))
}

/// The walk itself, apart from the command so the test runs the SAME body —
/// a test that re-implements the walk keeps passing while the command drifts.
fn walk_media(root: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.filter_map(|e| e.ok()) {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue; }
            if path.is_dir() {
                stack.push(path);
            } else if !name.ends_with(".part") && !name.ends_with(".tmp") {
                if let Ok(rel) = path.strip_prefix(root) {
                    // Keys are written with forward slashes on every platform —
                    // they are object keys, not native paths.
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    out
}

/// PUT one local file at a presigned URL.
///
/// The bytes never enter the webview. A 4GB render read into JavaScript as
/// base64 to be uploaded is 5.3GB of string in a tab that also has to stay
/// responsive; here it is a file handle and a stream. It is also why sync can
/// report progress per FILE and not per chunk.
#[tauri::command]
pub async fn local_media_upload(
    app: AppHandle,
    project_id: String,
    key: String,
    url: String,
    content_type: String,
) -> Result<u64, String> {
    let path = media_path(&app, &project_id, &key)?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("{key}: {e}"))?;
    let len = bytes.len() as u64;
    let res = tauri_plugin_http::reqwest::Client::new()
        .put(&url)
        .header("content-type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("upload of {key} failed ({})", res.status()));
    }
    Ok(len)
}

/// GET a URL straight into the project's media directory, for the other
/// direction: taking a cloud project offline.
#[tauri::command]
pub async fn local_media_download(
    app: AppHandle,
    project_id: String,
    key: String,
    url: String,
) -> Result<u64, String> {
    let path = media_path(&app, &project_id, &key)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    let res = tauri_plugin_http::reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("download of {key} failed ({})", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    // Same rule as `local_store_save`: land it under a temp name and rename,
    // so an interrupted pull leaves no half file that `local_media_exists`
    // would then report as present.
    let tmp = path.with_extension("part");
    tokio::fs::write(&tmp, &bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE DOCUMENT TRAVELS AS BYTES, and this is the contract that says so.
    ///
    /// It matters because the failure is silent in the worst way available:
    /// `saveNow` catches its own error and logs to a console nobody is
    /// reading, so a broken raw-body contract is an app that quietly stops
    /// saving and looks perfectly well until somebody quits it.
    #[test]
    fn a_raw_invoke_names_its_project_and_hands_over_the_document() {
        let doc = r#"{"version":1,"tables":{"beats":[{"action":"she says “no” — and leaves"}]}}"#;
        let mut headers = tauri::http::HeaderMap::new();
        headers.insert("qamba-project", "2ac500cb-9cf5-4f5c-8f50-919511ba1984".parse().unwrap());

        let (id, bytes) =
            save_target(&headers, &InvokeBody::Raw(doc.as_bytes().to_vec())).unwrap();
        assert_eq!(id, "2ac500cb-9cf5-4f5c-8f50-919511ba1984");
        // Multibyte on purpose: a storyboard is full of em dashes and curly
        // quotes, and the whole claim is that nothing re-encodes them.
        assert_eq!(bytes, doc.as_bytes());
    }

    #[test]
    fn a_save_that_names_no_project_or_carries_no_bytes_is_refused() {
        let mut headers = tauri::http::HeaderMap::new();
        // A JSON body is the half-rolled-back build. Writing nothing while
        // reporting success would be worse than refusing.
        headers.insert("qamba-project", "2ac500cb-9cf5-4f5c-8f50-919511ba1984".parse().unwrap());
        assert!(save_target(&headers, &InvokeBody::Json(serde_json::json!({"json": "{}"}))).is_err());

        // And no header at all, whatever the body: there is no project to
        // write to, and guessing one would write over somebody else's.
        let empty = tauri::http::HeaderMap::new();
        assert!(save_target(&empty, &InvokeBody::Raw(b"{}".to_vec())).is_err());
    }

    /// The write itself, against a real directory — including the OVERWRITE,
    /// which is what actually runs every time after the first.
    #[tokio::test]
    async fn the_project_file_is_replaced_atomically_and_left_alone_otherwise() {
        let dir = std::env::temp_dir().join(format!("qamba-save-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();

        write_project(&dir, b"{\"revision\":1}").await.unwrap();
        assert_eq!(std::fs::read(dir.join("project.json")).unwrap(), b"{\"revision\":1}");

        // Bigger, then smaller: a rename REPLACES, where a truncating write
        // that failed halfway would leave the tail of the previous document.
        let big = format!(r#"{{"revision":2,"pad":"{}"}}"#, "x".repeat(4096));
        write_project(&dir, big.as_bytes()).await.unwrap();
        assert_eq!(std::fs::read(dir.join("project.json")).unwrap(), big.as_bytes());
        write_project(&dir, b"{\"revision\":3}").await.unwrap();
        assert_eq!(std::fs::read(dir.join("project.json")).unwrap(), b"{\"revision\":3}");

        // Nothing half-written is left beside the real file.
        assert!(!dir.join("project.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The walk behind the plane's present-set: nested keys come back as
    /// forward-slash RELATIVE paths, and a half-written `.part` is never
    /// counted — a file that is not wholly here must resolve to the CDN, not
    /// to a truncated local copy.
    #[test]
    fn the_media_walk_returns_relative_keys_and_skips_partials() {
        let root = std::env::temp_dir().join(format!("qamba-medialist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let media = root.join("media");
        std::fs::create_dir_all(media.join("blocks/EP03/015")).unwrap();
        std::fs::write(media.join("blocks/EP03/015/take_a.mp4"), b"x").unwrap();
        std::fs::write(media.join("top.png"), b"x").unwrap();
        std::fs::write(media.join("blocks/half.mp4.part"), b"x").unwrap();
        std::fs::write(media.join(".DS_Store"), b"x").unwrap();

        let mut out = walk_media(&media);
        out.sort();
        assert_eq!(out, vec!["blocks/EP03/015/take_a.mp4".to_string(), "top.png".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_key_may_not_escape_the_project() {
        for bad in [
            "../../../etc/passwd",
            "/etc/passwd",
            "images/../../secret",
            "..",
            "",
            "C:/Windows/System32/x.dll",
            "images\\x.png",
            "https://example.com/x.png",
            ".ssh/id_rsa",
            "images/.ssh",
        ] {
            assert!(safe_key(bad).is_err(), "{bad:?} should have been refused");
        }
    }

    #[test]
    fn the_keys_this_app_actually_writes_are_accepted() {
        for good in [
            "images/9f1c2b3a-0000-4000-8000-000000000000.png",
            "audio/lines/9f1c2b3a0000.mp3",
            "video/take_01.mp4",
            "previews/job-1.jpg",
        ] {
            assert!(safe_key(good).is_ok(), "{good:?} should have been accepted");
        }
        assert_eq!(
            safe_key("images/a.png").unwrap(),
            PathBuf::from("images").join("a.png")
        );
    }

    #[test]
    fn a_project_id_must_be_uuid_shaped() {
        assert!(safe_id("11111111-1111-4111-8111-111111111111").is_ok());
        for bad in ["..", "a/b", "", "11111111-1111-4111-8111-11111111111", "../../local"] {
            assert!(safe_id(bad).is_err(), "{bad:?} should have been refused");
        }
    }
}
