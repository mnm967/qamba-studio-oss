//! PostgREST on loopback, answered by the webview.
//!
//! THE PROBLEM. The studio's pipeline is Python and every database touch in it
//! goes through `worker/sb.py`, which speaks PostgREST paths. A LOCAL project's
//! rows are not in Postgres at all — they are a JSON file under the app's data
//! directory, held in memory by the webview's `LocalStore` and written back on
//! a throttle. So "run the studio's own planner on a local project" needs the
//! Python and the file to meet somewhere.
//!
//! WHY NOT JUST READ THE FILE FROM RUST. Because the webview is already
//! writing it. Two writers on one JSON document, one of them coalescing
//! several seconds of edits in memory, is a race whose loser is silently the
//! whole project: the browser's next save overwrites every row the planner
//! wrote, and nothing anywhere reports it. There is exactly one writer, and
//! this is how everything else reaches it.
//!
//! WHAT IT IS. An ephemeral loopback listener. `plan_run` points the child's
//! `SUPABASE_URL` at it, so `sb.py` — unchanged, not one line — sends its
//! ordinary requests here. Each one is handed to the webview over an event,
//! answered by `localRest.ts` out of the open store, and handed back through
//! the `local_db_reply` command.
//!
//! THE TOKEN IS THE WHOLE ACCESS CONTROL, and it has to be. A loopback port is
//! reachable by every process running as this user, and this one answers reads
//! and writes for a project. So: a fresh random token per run, sent as the
//! bearer (which `sb.py` already does — it is the Supabase access token slot),
//! checked before anything is emitted, and dropped when the run ends. A
//! request without it never reaches the webview.
//!
//! IT IS ONLY STARTED FOR A LOCAL PROJECT. A cloud project's desktop job
//! talks to Supabase directly, as it already did — proxying it would add a
//! webview round trip per query and a second way for the same read to fail,
//! to arrive at the same rows. What the two share is the PYTHON: `sb.py` and
//! every handler above it are identical either way, and the plane is decided
//! entirely by which URL the child was started with.
//!
//! THE PROJECT IS PINNED TO THE SESSION, not read off the request. The Python
//! has no way to name a project on the wire (PostgREST paths carry a table and
//! filters, nothing more), and inferring one from a `project_id=eq.` filter
//! would be wrong for every read that has none — `jobs?id=eq.X` among them.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// How long one request may wait for the webview.
///
/// `sb.py`'s own timeout is 30s, so anything longer is answered into a socket
/// nobody is reading. A window that reloaded mid-run never answers at all, and
/// the job should fail with a sentence rather than hang until the app quits.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// Requests are small (a row, a filter). A body larger than this is not a
/// query, and reading an unbounded one off a socket is how a loopback listener
/// becomes an out-of-memory bug.
const MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct Incoming {
    id: u64,
    /// the local project whose store answers this request
    project: String,
    method: String,
    path: String,
    body: Option<String>,
    prefer: Option<String>,
}

#[derive(Default)]
pub struct DbProxy {
    inner: Mutex<Inner>,
    next: AtomicU64,
}

#[derive(Default)]
struct Inner {
    port: Option<u16>,
    /// token -> the ONE project its holder may reach. A token is the whole
    /// access control here, so it may never widen to "any project".
    sessions: HashMap<String, String>,
    waiting: HashMap<u64, oneshot::Sender<(u16, String)>>,
}

/// Open a session and return `(port, token)`.
///
/// The listener is started once and lives for the app; the SESSION is what is
/// per-run. A listener per run would mean a bind, an accept task and a
/// shutdown path for every job — three things to get wrong for a socket that
/// costs nothing to leave open on loopback.
pub async fn open_session(app: &AppHandle, project: String) -> Result<(u16, String), String> {
    let state = app.state::<DbProxy>();
    let port = ensure_listener(app, &state).await?;
    let token = uuid::Uuid::new_v4().to_string();
    state
        .inner
        .lock()
        .map_err(|_| "the db proxy state is poisoned")?
        .sessions
        .insert(token.clone(), project);
    Ok((port, token))
}

/// Close one session. Every later request with that token is a 401.
pub fn close_session(app: &AppHandle, token: &str) {
    if let Some(state) = app.try_state::<DbProxy>() {
        if let Ok(mut inner) = state.inner.lock() {
            inner.sessions.remove(token);
        }
    }
}

async fn ensure_listener(app: &AppHandle, state: &State<'_, DbProxy>) -> Result<u16, String> {
    if let Some(p) = state.inner.lock().map_err(|_| "the db proxy state is poisoned")?.port {
        return Ok(p);
    }
    // Port 0: the OS picks. A fixed one collides with whatever else holds it,
    // and a stale listener from a previous run would keep the port while the
    // new run waits for requests the old one is receiving.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("could not open a local port for the pipeline: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    state.inner.lock().map_err(|_| "the db proxy state is poisoned")?.port = Some(port);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(&app, sock).await {
                    eprintln!("[dbproxy] {e}");
                }
            });
        }
    });
    Ok(port)
}

/// One request, start to finish.
async fn serve(app: &AppHandle, mut sock: tokio::net::TcpStream) -> Result<(), String> {
    let (method, path, headers, body) = read_request(&mut sock).await?;

    let token = headers
        .get("authorization")
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .unwrap_or("")
        .to_string();

    let state = app.state::<DbProxy>();
    // Resolved in its OWN scope: a MutexGuard is not Send, and holding one
    // across the `respond(...).await` below makes this whole task un-spawnable.
    // The same rule `oauth::oauth_wait` states one file over.
    let project = {
        let inner = state.inner.lock().map_err(|_| "the db proxy state is poisoned")?;
        inner.sessions.get(&token).cloned()
    };
    // Never emitted to the webview: an unknown token has no session, so there
    // is no project it could be asking about.
    let Some(project) = project else {
        return respond(&mut sock, 401, r#"{"message":"not this session"}"#).await;
    };

    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    state
        .inner
        .lock()
        .map_err(|_| "the db proxy state is poisoned")?
        .waiting
        .insert(id, tx);

    let emitted = app.emit(
        "localdb://request",
        Incoming {
            id,
            project,
            method,
            path,
            body,
            prefer: headers.get("prefer").cloned(),
        },
    );
    if emitted.is_err() {
        state.inner.lock().ok().and_then(|mut i| i.waiting.remove(&id));
        return respond(&mut sock, 503, r#"{"message":"the app window is not listening"}"#).await;
    }

    match tokio::time::timeout(REPLY_TIMEOUT, rx).await {
        Ok(Ok((status, body))) => respond(&mut sock, status, &body).await,
        _ => {
            // Drop the slot so a late reply cannot land on the next request's
            // id — an answer delivered to the wrong query is worse than none.
            state.inner.lock().ok().and_then(|mut i| i.waiting.remove(&id));
            respond(
                &mut sock,
                504,
                r#"{"message":"the app window did not answer — was it reloaded mid-job?"}"#,
            )
            .await
        }
    }
}

/// Read one HTTP/1.1 request: the line, the headers, and exactly
/// `Content-Length` bytes of body.
async fn read_request(
    sock: &mut tokio::net::TcpStream,
) -> Result<(String, String, HashMap<String, String>, Option<String>), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    // Headers first. A request can be split across reads, so this loops for
    // the blank line rather than trusting one read to contain it.
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("the client closed before sending a request".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > 64 * 1024 {
            return Err("request headers too large".into());
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let start = lines.next().unwrap_or("");
    let mut parts = start.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();

    let mut headers = HashMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let want: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if want > MAX_BODY {
        return Err("request body too large".into());
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < want {
        let n = sock.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let body = if want == 0 {
        None
    } else {
        Some(String::from_utf8_lossy(&body[..want.min(body.len())]).to_string())
    };
    Ok((method, path, headers, body))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

async fn respond(sock: &mut tokio::net::TcpStream, status: u16, body: &str) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    // A 204 CARRIES NEITHER A BODY NOR A LENGTH. RFC 7230 §3.3.2 forbids
    // `Content-Length` on one outright, and `sb.patch`/`sb.delete` answer 204
    // on every write that did not ask for its rows back — which is most of
    // them, so a client that objected would object constantly.
    //
    // `Connection: close` on purpose. `requests` keeps a session alive per
    // process and would happily pipeline, but this listener answers one
    // request per connection and closing is what makes that unambiguous.
    let head = if status == 204 {
        format!("HTTP/1.1 {status} {reason}\r\nConnection: close\r\n\r\n")
    } else {
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len())
    };
    sock.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    if status != 204 {
        sock.write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let _ = sock.flush().await;
    Ok(())
}

/// The webview's answer to one emitted request.
#[tauri::command]
pub fn local_db_reply(state: State<'_, DbProxy>, id: u64, status: u16, body: String) -> Result<(), String> {
    let tx = state
        .inner
        .lock()
        .map_err(|_| "the db proxy state is poisoned")?
        .waiting
        .remove(&id);
    match tx {
        // A reply that arrives after the timeout has nowhere to go. Not an
        // error to the caller — the request has already been answered 504 and
        // the job has already seen it.
        None => Ok(()),
        Some(tx) => {
            let _ = tx.send((status, body));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt as _;

    async fn round_trip(raw: &str) -> (String, String, HashMap<String, String>, Option<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let raw = raw.to_string();
        tokio::spawn(async move {
            let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
            // Deliberately in two writes with a pause: a real request CAN
            // arrive split across reads, and a parser that trusts one read to
            // contain the blank line loses the body.
            let (a, b) = raw.split_at(raw.len() / 2);
            c.write_all(a.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            c.write_all(b.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let (mut sock, _) = listener.accept().await.unwrap();
        read_request(&mut sock).await.unwrap()
    }

    #[tokio::test]
    async fn a_get_is_read_the_way_sb_py_sends_it() {
        let (method, path, headers, body) = round_trip(
            "GET /rest/v1/scenes?select=*&idx=eq.0 HTTP/1.1\r\n\
             Host: 127.0.0.1\r\napikey: anon\r\nAuthorization: Bearer tok\r\n\r\n",
        )
        .await;
        assert_eq!(method, "GET");
        assert_eq!(path, "/rest/v1/scenes?select=*&idx=eq.0");
        assert_eq!(headers.get("authorization").unwrap(), "Bearer tok");
        assert!(body.is_none());
    }

    #[tokio::test]
    async fn a_post_carries_its_body_and_its_prefer_header() {
        // `Prefer` is the ONLY thing separating an insert from an upsert on the
        // wire, and the only thing that says whether the rows come back.
        let payload = r#"{"b2_key":"audio/lines/x.mp3","kind":"audio"}"#;
        let (method, path, headers, body) = round_trip(&format!(
            "POST /rest/v1/assets?on_conflict=b2_key HTTP/1.1\r\n\
             Authorization: Bearer tok\r\n\
             Prefer: return=representation,resolution=merge-duplicates\r\n\
             Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len()
        ))
        .await;
        assert_eq!(method, "POST");
        assert_eq!(path, "/rest/v1/assets?on_conflict=b2_key");
        assert_eq!(
            headers.get("prefer").unwrap(),
            "return=representation,resolution=merge-duplicates"
        );
        assert_eq!(body.unwrap(), payload);
    }

    #[tokio::test]
    async fn a_body_with_multibyte_text_survives_the_split() {
        // A storyboard is full of them — em dashes, curly quotes, names. A
        // parser that slices the buffer by BYTE length and then decodes has to
        // not cut one in half.
        let payload = r#"{"action":"she says “no” — and leaves"}"#;
        let (_m, _p, _h, body) = round_trip(&format!(
            "PATCH /rest/v1/beats?id=eq.1 HTTP/1.1\r\nAuthorization: Bearer t\r\n\
             Content-Length: {}\r\n\r\n{payload}",
            payload.len()
        ))
        .await;
        assert_eq!(body.unwrap(), payload);
    }

    #[tokio::test]
    async fn a_response_is_something_an_http_client_can_read_back() {
        // Written by hand, so the bytes are the contract. A 204 must carry
        // neither a body nor a `Content-Length` (RFC 7230 §3.3.2) and it is
        // the answer to nearly every write `sb.py` makes.
        async fn render(status: u16, body: &str) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let body = body.to_string();
            tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                respond(&mut sock, status, &body).await.unwrap();
            });
            let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
            let mut out = String::new();
            use tokio::io::AsyncReadExt as _;
            c.read_to_string(&mut out).await.unwrap();
            out
        }

        let ok = render(200, r#"[{"id":"x"}]"#).await;
        assert!(ok.starts_with("HTTP/1.1 200 OK\r\n"), "{ok}");
        assert!(ok.contains("Content-Length: 12\r\n"), "{ok}");
        assert!(ok.ends_with("\r\n\r\n[{\"id\":\"x\"}]"), "{ok}");

        let empty = render(204, "").await;
        assert!(empty.starts_with("HTTP/1.1 204 No Content\r\n"), "{empty}");
        assert!(!empty.contains("Content-Length"), "a 204 may not declare one: {empty}");
        assert!(empty.ends_with("\r\n\r\n"), "{empty}");
    }

    #[test]
    fn find_locates_the_header_terminator() {
        assert_eq!(find(b"GET /\r\n\r\nbody", b"\r\n\r\n"), Some(5));
        assert_eq!(find(b"no terminator", b"\r\n\r\n"), None);
    }
}
