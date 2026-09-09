//! A local project's media, over loopback HTTP.
//!
//! THE PROBLEM IS THE TRANSPORT, not the disk. Local media used to be served
//! by Tauri's `asset://` protocol, which is answered by a `WKURLSchemeHandler`
//! **on the app's main thread** and caps a single Range response at
//! `MAX_LEN = 1000 * 1024` (tauri's `protocol/asset.rs`). A take here is
//! 7-10MB, so every one of them was eight to ten sequential main-thread round
//! trips — and that is the same thread the IPC runs on, so a slice queued
//! behind another command's work arrives late, the element drops under
//! `readyState 3`, and `PreviewPlayer` shows "buffering…" for a file sitting
//! on the SSD. Measured on a fully local project, which is what made it
//! obviously not the network.
//!
//! WHAT THIS IS. An ephemeral loopback listener, one accept task per request,
//! off the main thread, with real Range support and no cap: WebKit's own media
//! loader asks for what it wants and gets it. The shape is `dbproxy`'s, next
//! door, for the same reasons — a port the OS picks, and a token.
//!
//! THE TOKEN IS THE WHOLE ACCESS CONTROL. A loopback port is reachable by
//! every process running as this user, and this one reads files out of the
//! app's data directory. So it is a fresh random token per app run, it is the
//! first path segment of every URL, and it is checked before a path is even
//! built. `safe_key` then decides whether the rest may name a file at all —
//! the same defence the write side has always had, for the same reason: a key
//! can arrive from an imported project or a row somebody else wrote.
//!
//! IT SENDS `Access-Control-Allow-Origin: *`, which is a small bonus rather
//! than the point: `asset://` answers with the window's own origin, so this
//! changes nothing for the player and means the audio effects rack can read
//! local media with no proxy at all.
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::localstore::{media_root, safe_key};

/// How much of a file goes out per write. Large enough that a 10MB take is
/// forty writes rather than ten thousand, small enough that a client that
/// seeks away mid-response is noticed promptly.
const CHUNK: usize = 256 * 1024;

/// A request line plus headers longer than this is not a media request.
const MAX_HEAD: usize = 16 * 1024;

#[derive(Default)]
pub struct MediaServer {
    inner: Mutex<Option<Origin>>,
}

#[derive(Clone)]
struct Origin {
    port: u16,
    token: String,
}

/// `http://127.0.0.1:<port>/<token>` — everything the browser needs to build a
/// URL for a key, which it then does synchronously.
///
/// Asked for ONCE, by `bootLocalPlane`, and therefore on every desktop launch
/// rather than only where a local project exists: `localMediaUrl` cannot await
/// anything, so the origin has to be in hand before the first render, and a
/// project created later would otherwise silently fall back to `asset://`
/// until the app was restarted. It is one listening socket on loopback.
#[tauri::command]
pub async fn local_media_origin(app: AppHandle) -> Result<String, String> {
    let o = ensure(&app).await?;
    Ok(format!("http://127.0.0.1:{}/{}", o.port, o.token))
}

async fn ensure(app: &AppHandle) -> Result<Origin, String> {
    // Scoped: a MutexGuard is not Send, and holding one across the bind below
    // makes this future un-spawnable. The rule `dbproxy::serve` states.
    if let Some(o) = current(app)? {
        return Ok(o);
    }

    // Port 0: the OS picks. A fixed one collides with whatever else holds it,
    // and a stale listener from a previous run would keep the port while the
    // new run waited for requests the old one was receiving.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a local port for media: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let origin = Origin { port, token: uuid::Uuid::new_v4().to_string() };

    {
        let state = app.state::<MediaServer>();
        let mut cur = state.inner.lock().map_err(|_| "the media server state is poisoned")?;
        // Lost a race with another caller: theirs is already serving, so drop
        // ours (which closes the listener) rather than running two.
        if let Some(existing) = cur.clone() {
            return Ok(existing);
        }
        *cur = Some(origin.clone());
    }

    let app = app.clone();
    let token = origin.token.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(&app, &token, sock).await {
                    // A client that seeks away mid-response closes the socket,
                    // which lands here as a write error. Ordinary, and not
                    // worth a line per seek.
                    if !e.contains("Broken pipe") && !e.contains("reset") {
                        eprintln!("[media] {e}");
                    }
                }
            });
        }
    });
    Ok(origin)
}

fn current(app: &AppHandle) -> Result<Option<Origin>, String> {
    let state = app.state::<MediaServer>();
    let cur = state.inner.lock().map_err(|_| "the media server state is poisoned")?.clone();
    Ok(cur)
}

/// One request, start to finish.
async fn serve(app: &AppHandle, token: &str, mut sock: TcpStream) -> Result<(), String> {
    let (method, target, headers) = read_head(&mut sock).await?;

    if method == "OPTIONS" {
        // No body and no `Content-Length` — RFC 7230 §3.3.2 forbids one on a
        // 204, and `write_head` omits it for a `None` length.
        return write_head(&mut sock, 204, &[], None).await;
    }
    if method != "GET" && method != "HEAD" {
        return error(&mut sock, 405, "only GET, HEAD and OPTIONS are allowed").await;
    }

    // The query string is not part of the key. Callers append their own
    // (`?qambacors=1` on the CORS-mode element, `?p=<progress>` on a job
    // preview) and a server that folded one into the path would 404 on it.
    let path = target.split('?').next().unwrap_or("");
    let Some(file) = resolve(app, token, path) else {
        return error(&mut sock, 404, "no such media").await;
    };
    let range = headers.iter().find(|(k, _)| k == "range").map(|(_, v)| v.as_str());
    serve_file(&mut sock, &file, &method, range).await
}

/// The half that touches the file, apart from the half that decides WHICH
/// file — so a test can drive this one over a real socket against a real file.
/// A test that re-implemented the loop would go on passing while this drifted.
async fn serve_file(
    sock: &mut TcpStream,
    file: &std::path::Path,
    method: &str,
    range: Option<&str>,
) -> Result<(), String> {
    let mut f = match tokio::fs::File::open(file).await {
        Ok(f) => f,
        Err(_) => return error(sock, 404, "no such media").await,
    };
    let len = f.metadata().await.map_err(|e| e.to_string())?.len();
    let mime = mime_for(file);

    let (start, end) = match range.map(|r| parse_range(r, len)) {
        None => (0, len.saturating_sub(1)),
        Some(Some(r)) => r,
        // Unsatisfiable. A 416 must carry the real length or the client cannot
        // work out what it should have asked for instead.
        Some(None) => {
            return write_head(
                sock,
                416,
                &[("Content-Range", &format!("bytes */{len}")), ("Content-Type", &mime)],
                Some(0),
            )
            .await;
        }
    };

    let partial = range.is_some();
    let count = if len == 0 { 0 } else { end - start + 1 };
    let content_range = format!("bytes {start}-{end}/{len}");
    let mut head: Vec<(&str, &str)> = vec![("Content-Type", &mime), ("Accept-Ranges", "bytes")];
    if partial {
        head.push(("Content-Range", &content_range));
    }
    write_head(sock, if partial { 206 } else { 200 }, &head, Some(count)).await?;

    if method == "HEAD" || count == 0 {
        let _ = sock.flush().await;
        return Ok(());
    }

    f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| e.to_string())?;
    let mut left = count;
    let mut buf = vec![0u8; CHUNK.min(count as usize).max(1)];
    while left > 0 {
        let want = (left as usize).min(buf.len());
        let n = f.read(&mut buf[..want]).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break; // the file shrank under us; the client sees a short body
        }
        sock.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        left -= n as u64;
    }
    let _ = sock.flush().await;
    Ok(())
}

/// `/<token>/<project>/<key…>` to a file, or None.
///
/// Every refusal is the same 404: which of "wrong token", "no such project"
/// and "no such file" it was is not something an unauthenticated caller gets
/// to learn.
fn resolve(app: &AppHandle, token: &str, path: &str) -> Option<PathBuf> {
    let (project, key) = split_target(token, path)?;
    let root = media_root(app, &project).ok()?;
    let safe = safe_key(&key).ok()?;
    Some(root.join(safe))
}

/// The access control, apart from the file lookup so it can be tested without
/// an app: a bad token must never reach a path at all.
fn split_target(token: &str, path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix('/')?;
    let (got, rest) = rest.split_once('/')?;
    if got != token {
        return None;
    }
    let (project, key) = rest.split_once('/')?;
    let key = percent_decode(key);
    if key.is_empty() {
        return None;
    }
    Some((percent_decode(project), key))
}

/// Minimal percent-decoding, so this file needs no new dependency. Invalid
/// escapes are left alone rather than dropped — a key is a filename, and
/// mangling one silently 404s where an untouched one merely does not match.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `bytes=a-b`, `bytes=a-` and `bytes=-n`, resolved against the file's length.
///
/// ONE range only, deliberately: a media element never asks for more, and a
/// multipart response is a boundary format to get wrong for no one. A request
/// naming several is answered with the first, which is legal.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let last = len - 1;
    if a.is_empty() {
        // A suffix range: the final N bytes. N of 0 is unsatisfiable.
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), last));
    }
    let start: u64 = a.parse().ok()?;
    if start > last {
        return None;
    }
    let end = if b.is_empty() { last } else { b.parse::<u64>().ok()?.min(last) };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn mime_for(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "json" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Read the request line and headers. No body: this serves GET and HEAD.
async fn read_head(sock: &mut TcpStream) -> Result<(String, String, Vec<(String, String)>), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the client closed before sending a request".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > MAX_HEAD {
            return Err("request headers too large".into());
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or("").split(' ');
    let method = start.next().unwrap_or("").to_ascii_uppercase();
    let target = start.next().unwrap_or("/").to_string();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Ok((method, target, headers))
}

async fn write_head(
    sock: &mut TcpStream,
    status: u16,
    extra: &[(&str, &str)],
    length: Option<u64>,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    // `*` rather than the window's origin: this server answers one machine's
    // own files and the token is what gates them, so echoing an Origin back
    // would add a header to get wrong without adding a check.
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
    head.push_str("Access-Control-Allow-Headers: range\r\n");
    head.push_str("Access-Control-Expose-Headers: content-length, content-range, accept-ranges\r\n");
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(n) = length {
        head.push_str(&format!("Content-Length: {n}\r\n"));
    }
    // One request per connection. Keep-alive would mean parsing a second
    // request off the same socket; loopback connects cost microseconds and a
    // media element makes few of them.
    head.push_str("Connection: close\r\n\r\n");
    sock.write_all(head.as_bytes()).await.map_err(|e| e.to_string())
}

async fn error(sock: &mut TcpStream, status: u16, msg: &str) -> Result<(), String> {
    write_head(
        sock,
        status,
        &[("Content-Type", "text/plain; charset=utf-8")],
        Some(msg.len() as u64),
    )
    .await?;
    sock.write_all(msg.as_bytes()).await.map_err(|e| e.to_string())?;
    let _ = sock.flush().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_header_resolves_against_the_length() {
        // The three forms a media element sends, plus the ones it does not.
        assert_eq!(parse_range("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
        // An end past the file is CLAMPED, not refused — WebKit asks for more
        // than it can have routinely, and refusing stalls the load.
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-0", 1000), Some((0, 0)));
        // Several ranges: the first is answered, which is legal.
        assert_eq!(parse_range("bytes=0-9,20-29", 1000), Some((0, 9)));

        assert_eq!(parse_range("bytes=1000-", 1000), None); // starts past the end
        assert_eq!(parse_range("bytes=-0", 1000), None);    // an empty suffix
        assert_eq!(parse_range("bytes=0-499", 0), None);    // an empty file
        assert_eq!(parse_range("items=0-1", 1000), None);   // not bytes
        assert_eq!(parse_range("bytes=abc", 1000), None);
    }

    #[test]
    fn a_key_is_decoded_but_never_mangled() {
        assert_eq!(percent_decode("blocks/EP03/take%20one.mp4"), "blocks/EP03/take one.mp4");
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        // A stray `%` is not an escape and must survive as itself.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    /// THE BYTES ARE THE CONTRACT — this is a hand-written HTTP server, and
    /// every claim below is one a media element depends on. It drives the
    /// REAL `serve_file` over a REAL socket against a REAL file on disk, so
    /// the seek, the chunk loop and the header arithmetic are all under test
    /// rather than a second copy of them.
    async fn get(file: &std::path::Path, request: &str) -> (String, Vec<u8>) {
        use tokio::io::AsyncReadExt as _;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let path = file.to_path_buf();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let (method, target, headers) = read_head(&mut sock).await.unwrap();
            let _ = target;
            let range = headers.iter().find(|(k, _)| k == "range").map(|(_, v)| v.clone());
            serve_file(&mut sock, &path, &method, range.as_deref()).await.unwrap();
        });
        let mut c = TcpStream::connect(addr).await.unwrap();
        c.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        c.read_to_end(&mut out).await.unwrap();
        server.await.unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&out[..split]).to_string(), out[split + 4..].to_vec())
    }

    fn fixture(name: &str, bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("qamba-media-{}-{name}", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[tokio::test]
    async fn a_whole_file_comes_back_whole() {
        let body: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        let f = fixture("whole.mp4", &body);
        let (head, got) = get(&f, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("Content-Type: video/mp4"), "{head}");
        // Without this a media element will not even TRY a range request, and
        // seeking a video falls back to downloading it from the start.
        assert!(head.contains("Accept-Ranges: bytes"), "{head}");
        assert!(head.contains("Access-Control-Allow-Origin: *"), "{head}");
        assert!(head.contains("Content-Length: 4096"), "{head}");
        assert_eq!(got, body);
        std::fs::remove_file(&f).ok();
    }

    #[tokio::test]
    async fn a_range_is_the_bytes_it_names() {
        // The whole reason this server exists: `asset://` capped one response
        // at 1000 * 1024, so a 10MB take was ten main-thread round trips.
        let body: Vec<u8> = (0..=255u8).cycle().take(4 * 1024 * 1024).collect();
        let f = fixture("range.mp4", &body);

        let (head, got) = get(
            &f, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\nRange: bytes=1000-1999\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 206 Partial Content\r\n"), "{head}");
        assert!(head.contains("Content-Range: bytes 1000-1999/4194304"), "{head}");
        assert!(head.contains("Content-Length: 1000"), "{head}");
        assert_eq!(got, &body[1000..=1999]);

        // Past the old cap in ONE response, which is the point.
        let (head, got) = get(
            &f, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n").await;
        assert!(head.contains("Content-Range: bytes 0-4194303/4194304"), "{head}");
        assert_eq!(got.len(), body.len(), "no 1MB cap");
        assert_eq!(got, body);

        // The tail, which is how a player reads an mp4's moov atom when it is
        // at the end of the file.
        let (head, got) = get(
            &f, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\nRange: bytes=-64\r\n\r\n").await;
        assert!(head.contains("Content-Range: bytes 4194240-4194303/4194304"), "{head}");
        assert_eq!(got, &body[body.len() - 64..]);
        std::fs::remove_file(&f).ok();
    }

    #[tokio::test]
    async fn head_answers_the_headers_and_no_body() {
        let f = fixture("head.png", &[1u8; 512]);
        let (head, got) = get(&f, "HEAD /t/p/k.png HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("Content-Length: 512"), "a HEAD still declares the length: {head}");
        assert!(head.contains("Content-Type: image/png"), "{head}");
        assert!(got.is_empty(), "a HEAD must carry no body");
        std::fs::remove_file(&f).ok();
    }

    #[tokio::test]
    async fn an_unsatisfiable_range_says_how_long_the_file_is() {
        let f = fixture("short.mp4", &[7u8; 100]);
        let (head, _) = get(
            &f, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\nRange: bytes=500-600\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 416 Range Not Satisfiable\r\n"), "{head}");
        // Without the real length the client cannot work out what to ask for.
        assert!(head.contains("Content-Range: bytes */100"), "{head}");
        std::fs::remove_file(&f).ok();
    }

    #[tokio::test]
    async fn a_missing_file_is_a_404_rather_than_a_hang() {
        let missing = std::env::temp_dir().join("qamba-media-nope-nothing-here.mp4");
        std::fs::remove_file(&missing).ok();
        let (head, _) = get(&missing, "GET /t/p/k.mp4 HTTP/1.1\r\nHost: x\r\n\r\n").await;
        assert!(head.starts_with("HTTP/1.1 404 Not Found\r\n"), "{head}");
    }

    /// The token is the WHOLE access control — a loopback port is reachable by
    /// every process running as this user, and this one reads files out of the
    /// app's data directory.
    #[test]
    fn only_a_url_carrying_this_run_s_token_names_a_file() {
        let t = "9f2c-token";
        assert_eq!(
            split_target(t, "/9f2c-token/proj-1/blocks/EP03/take.mp4"),
            Some(("proj-1".into(), "blocks/EP03/take.mp4".into())),
            "a key keeps its slashes: it is a path of segments",
        );
        // Encoded segments are decoded, and the separators are not touched.
        assert_eq!(
            split_target(t, "/9f2c-token/proj-1/lib/take%20one.mp4"),
            Some(("proj-1".into(), "lib/take one.mp4".into())),
        );

        assert_eq!(split_target(t, "/wrong/proj-1/x.mp4"), None, "another token");
        assert_eq!(split_target(t, "/9f2c-tokenx/proj-1/x.mp4"), None, "a prefix is not a match");
        assert_eq!(split_target(t, "/9f2c-toke/proj-1/x.mp4"), None, "nor is a truncation");
        assert_eq!(split_target(t, "/proj-1/x.mp4"), None, "no token at all");
        assert_eq!(split_target(t, "/9f2c-token/proj-1"), None, "no key");
        assert_eq!(split_target(t, "/9f2c-token/proj-1/"), None, "an empty key");
        assert_eq!(split_target(t, "9f2c-token/proj-1/x.mp4"), None, "no leading slash");
        assert_eq!(split_target(t, "/"), None);
    }

    #[test]
    fn a_media_type_comes_off_the_extension() {
        assert_eq!(mime_for(std::path::Path::new("a/b/take.mp4")), "video/mp4");
        assert_eq!(mime_for(std::path::Path::new("x.PNG")), "image/png");
        assert_eq!(mime_for(std::path::Path::new("x.weird")), "application/octet-stream");
        assert_eq!(mime_for(std::path::Path::new("noext")), "application/octet-stream");
    }
}
