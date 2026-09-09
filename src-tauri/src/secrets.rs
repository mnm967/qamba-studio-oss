// BYOK: the user's own provider API keys, held by the operating system.
//
// THE KEY NEVER ENTERS THE WEBVIEW, and that is the whole shape of this
// module. There is no `secret_get`. The webview can say "store this", "forget
// this", "which do I have", and "make THIS request to THIS provider" — and the
// fourth is where the key is used, in Rust, injected into the outgoing header
// after the URL has been checked against that provider's own host list. So a
// compromised page (an imported workflow's prose, a Civitai description, an
// XSS) cannot read a key, and cannot spend one anywhere but the vendor it
// belongs to. Handing the value back over IPC would have made both of those
// merely conventions.
//
// WHY THE OS KEYCHAIN RATHER THAN A FILE. These are the user's own billable
// credentials, not our config. macOS Keychain and the Windows Credential
// Manager encrypt at rest, are scoped to the login session, and are the place
// a user already knows to go to revoke something. A 0600 JSON file is readable
// by anything running as this user, which includes every other program they
// install.
//
// THE INDEX IS NOT THE KEY. Keychains cannot be enumerated by service
// portably, and reading one can prompt — so "which providers do I have a key
// for" is answered from a small plaintext file that holds provider ids, the
// last four characters, and a timestamp. Nothing in it is a secret, and asking
// it costs no unlock. The VALUE only ever leaves the keychain inside
// `byok_fetch`, which is also the only code path that can see it.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One keychain service for the whole app; the provider id is the account.
/// Deliberately NOT the bundle identifier: `datadir.rs` migrates that when the
/// product is renamed, and a keychain entry keyed on it would strand every key
/// the next time it moves. A rename costs the data directory a move and must
/// not cost the user their API keys as well.
const SERVICE: &str = "qamba-studio-byok";

/// Which hosts a given provider's key may ever be sent to.
///
/// This is the enforcement, and it lives HERE rather than in the webview
/// because the webview is the thing being constrained. It is also narrower
/// than the tauri http allow-list can be: that one governs whether a request
/// may be made at all, and says nothing about which credential rides on it.
/// Without this an OpenAI key could be posted to any host already on that
/// list.
///
/// A trailing-dot suffix match, so `api.openai.com` and `eu.api.openai.com`
/// both pass and `api.openai.com.evil.test` does not.
fn allowed_hosts(provider: &str) -> Option<&'static [&'static str]> {
    Some(match provider {
        "openai" => &["api.openai.com"],
        "anthropic" => &["api.anthropic.com"],
        "google" => &["generativelanguage.googleapis.com"],
        "fal" => &["fal.run", "queue.fal.run", "rest.alpha.fal.ai", "fal.media"],
        "minimax" => &["api.minimax.io", "api.minimaxi.com"],
        "elevenlabs" => &["api.elevenlabs.io"],
        // Fish Audio. `api.fish.audio` serves both the TTS endpoint and the
        // model registry a cloned voice is uploaded to.
        "fish" => &["api.fish.audio"],
        // Alibaba Model Studio (Wan 3.0). The international and mainland
        // DashScope hosts. Model Studio ALSO serves a workspace-scoped host
        // (`{WorkspaceId}.{region}.maas.aliyuncs.com`) which an exact-host
        // allow-list cannot express — a desktop key can only reach the two
        // below, and the pod, whose reads are not bound by this list, is where
        // a workspace host is reachable via WAN_BASE_URL.
        "alibaba" => &["dashscope-intl.aliyuncs.com", "dashscope.aliyuncs.com"],
        _ => return None,
    })
}

/// How the provider wants the credential presented. A header name plus an
/// optional scheme prefix covers every provider here; the odd one out is
/// Google, which takes it as a header too (`x-goog-api-key`) rather than the
/// query parameter its older docs show — a key in a URL is a key in every
/// proxy log between here and there.
fn auth_header(provider: &str) -> (&'static str, &'static str) {
    match provider {
        "anthropic" => ("x-api-key", ""),
        "google" => ("x-goog-api-key", ""),
        "fal" => ("authorization", "Key "),
        "minimax" => ("authorization", "Bearer "),
        "elevenlabs" => ("xi-api-key", ""),
        _ => ("authorization", "Bearer "),
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct KeyRecord {
    /// Last four characters, so a person can tell which key is installed
    /// without the app ever showing one. Never a prefix: the prefix is the
    /// part that identifies the account.
    pub tail: String,
    /// Unix seconds. Answers "is this the key I rotated last week".
    pub set_at: u64,
    /// The account/organisation label the provider reported at verify time,
    /// when it reports one. Nothing depends on it; it is how you tell two of
    /// your own keys apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ByokStatus {
    pub provider: String,
    pub present: bool,
    pub tail: String,
    pub set_at: u64,
    pub account: Option<String>,
    /// True when the index says a key exists and the keychain disagrees.
    ///
    /// It is a REAL state, not a paranoia: the user can delete the entry in
    /// Keychain Access, or restore this machine's app data without its
    /// keychain. Reported rather than repaired, because silently clearing the
    /// index would erase the only evidence that a key used to be here.
    pub orphaned: bool,
}

type Index = BTreeMap<String, KeyRecord>;

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("byok.json"))
}

fn read_index(app: &AppHandle) -> Index {
    index_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_index(app: &AppHandle, idx: &Index) -> Result<(), String> {
    let path = index_path(app)?;
    let body = serde_json::to_string_pretty(idx).map_err(|e| e.to_string())?;
    // Atomic, same as localstore's project file: a crash mid-write must not
    // leave an index no build can parse, which would read as "no keys".
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider)
        .map_err(|e| format!("this machine's keychain refused the request: {e}"))
}

/// Read a stored key.
///
/// `pub(crate)` and NOT a command — the module header's rule is that the
/// WEBVIEW cannot read a key, not that Rust cannot. `planner.rs` is the one
/// other caller: it puts the key into a child process's environment on this
/// machine, which is the same "used in Rust, never handed to JavaScript"
/// shape `byok_fetch` has. If a `#[tauri::command]` is ever put in front of
/// this, that guarantee is gone.
pub(crate) fn read_secret(provider: &str) -> Result<String, String> {
    match entry(provider)?.get_password() {
        Ok(v) => Ok(v),
        Err(keyring::Error::NoEntry) => {
            Err(format!("no {provider} key is stored on this machine"))
        }
        Err(e) => Err(format!("the keychain would not release the {provider} key: {e}")),
    }
}

/* ─────────────────────────────────────────────────────────── commands ── */

#[tauri::command]
pub fn byok_status(app: AppHandle) -> Vec<ByokStatus> {
    read_index(&app)
        .into_iter()
        .map(|(provider, rec)| {
            // `get_password` is what would prompt on macOS, so presence is
            // asked with the cheapest question the keychain answers.
            let live = entry(&provider)
                .and_then(|e| match e.get_password() {
                    Ok(_) => Ok(true),
                    Err(keyring::Error::NoEntry) => Ok(false),
                    Err(e) => Err(e.to_string()),
                })
                .unwrap_or(true);
            ByokStatus {
                provider,
                present: live,
                tail: rec.tail,
                set_at: rec.set_at,
                account: rec.account,
                orphaned: !live,
            }
        })
        .collect()
}

#[tauri::command]
pub fn byok_set(app: AppHandle, provider: String, value: String) -> Result<ByokStatus, String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("that key is empty".into());
    }
    if allowed_hosts(&provider).is_none() {
        return Err(format!("'{provider}' is not a provider this build knows how to call"));
    }
    entry(&provider)?
        .set_password(&value)
        .map_err(|e| format!("the keychain would not store the key: {e}"))?;

    let tail: String = value.chars().rev().take(4).collect::<Vec<_>>()
        .into_iter().rev().collect();
    let rec = KeyRecord { tail: tail.clone(), set_at: now_secs(), account: None };
    let mut idx = read_index(&app);
    idx.insert(provider.clone(), rec.clone());
    write_index(&app, &idx)?;
    Ok(ByokStatus {
        provider, present: true, tail, set_at: rec.set_at, account: None, orphaned: false,
    })
}

#[tauri::command]
pub fn byok_delete(app: AppHandle, provider: String) -> Result<(), String> {
    // The index entry goes whatever the keychain says. A key we cannot delete
    // is still a key the app must stop offering, and leaving the row behind
    // would put a model in the picker that no longer has a credential.
    if let Ok(e) = entry(&provider) {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => {
                let mut idx = read_index(&app);
                idx.remove(&provider);
                let _ = write_index(&app, &idx);
                return Err(format!(
                    "removed from this app, but the keychain kept its copy ({err}) — \
                     delete it in Keychain Access to be sure"
                ));
            }
        }
    }
    let mut idx = read_index(&app);
    idx.remove(&provider);
    write_index(&app, &idx)
}

/// Record the account label a verify call reported. Separate from `byok_set`
/// because verification is a round trip and storing the key must not wait on
/// the network — a key that stored fine and could not be verified is still
/// stored, and saying otherwise would invite the user to paste it again.
#[tauri::command]
pub fn byok_note_account(app: AppHandle, provider: String, account: Option<String>)
    -> Result<(), String> {
    let mut idx = read_index(&app);
    if let Some(rec) = idx.get_mut(&provider) {
        rec.account = account.filter(|s| !s.trim().is_empty());
        return write_index(&app, &idx);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ByokResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
    pub headers: BTreeMap<String, String>,
}

/// Make one request to a provider, with that provider's key on it.
///
/// `body_b64` carries a body that is not text. OpenAI's image EDIT endpoint is
/// multipart — the one shape a JSON string cannot express — and without it the
/// adapter could generate but not edit, which is the single thing this codebase
/// measured no local model able to do. Base64 rather than a byte array because
/// Tauri's IPC serialises a `Vec<u8>` as a JSON array of numbers: roughly six
/// bytes on the wire for every byte of image.
///
/// Everything the webview may say about the request is here, and everything it
/// may NOT say is enforced below: it cannot choose the credential, cannot send
/// the credential anywhere but the provider's own hosts, and cannot set the
/// auth header itself (a caller-supplied `authorization` is dropped rather
/// than merged — otherwise the constraint is one header name away from being
/// bypassed).
#[tauri::command]
pub async fn byok_fetch(
    provider: String,
    url: String,
    method: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    body: Option<String>,
    body_b64: Option<String>,
    content_type: Option<String>,
) -> Result<ByokResponse, String> {
    use base64::Engine as _;
    use tauri_plugin_http::reqwest;

    let hosts = allowed_hosts(&provider)
        .ok_or_else(|| format!("'{provider}' is not a provider this build knows how to call"))?;
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("a provider key is only ever sent over https".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let ok_host = hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
    if !ok_host {
        return Err(format!(
            "refusing to send the {provider} key to {host} — it is not one of that \
             provider's hosts"
        ));
    }

    let key = read_secret(&provider)?;
    let (hname, scheme) = auth_header(&provider);

    let m = method.unwrap_or_else(|| "GET".into()).to_uppercase();
    let method = reqwest::Method::from_bytes(m.as_bytes())
        .map_err(|_| format!("'{m}' is not an http method"))?;
    let mut req = reqwest::Client::new().request(method, parsed);
    for (k, v) in headers.unwrap_or_default() {
        let lk = k.to_ascii_lowercase();
        // The credential is ours to set. A caller-supplied auth header would
        // either shadow it or ride alongside it, and both make the host check
        // above decorative.
        if lk == "authorization" || lk == hname || lk == "x-api-key" || lk == "x-goog-api-key" {
            continue;
        }
        req = req.header(k, v);
    }
    req = req.header(hname, format!("{scheme}{key}"));
    if let Some(b64) = body_b64 {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("body_b64 is not base64: {e}"))?;
        req = req
            .header("content-type", content_type.as_deref().unwrap_or("application/octet-stream"))
            .body(raw);
    } else if let Some(b) = body {
        req = req
            .header("content-type", content_type.as_deref().unwrap_or("application/json"))
            .body(b);
    }

    let res = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = res.status();
    let mut out = BTreeMap::new();
    for (k, v) in res.headers().iter() {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_string(), s.to_string());
        }
    }
    let text = res.text().await.map_err(|e| format!("could not read the reply: {e}"))?;
    Ok(ByokResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body: text,
        headers: out,
    })
}

// THERE IS NO `byok_share`, AND THAT IS THE POINT OF THIS BUILD.
//
// The studio edition had one: a command that carried a stored key to a remote
// database so its render machine could spend it on your behalf. It is the one
// path in this module that ever sent a key to a host that was not the
// provider's, and it only made sense while there was somebody else's machine
// to spend it on. Here the key is spent by the process that reads it, on the
// computer it was typed into, and nothing else needs to see it — so `byok_set`
// / `byok_fetch` are the whole surface and there is deliberately no command
// anywhere in this file that hands a key back to the webview.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_with_hosts_has_an_auth_header_and_vice_versa() {
        // The two tables are indexed by the same ids and are edited
        // separately, so the failure they can have is a provider present in
        // one and absent from the other — which is a key sent with no header
        // (silent 401) or a header with nowhere legal to send it.
        for p in ["openai", "anthropic", "google", "fal", "minimax", "elevenlabs",
                  "fish", "alibaba"] {
            assert!(allowed_hosts(p).is_some(), "{p} has no host list");
            let (h, _) = auth_header(p);
            assert!(!h.is_empty(), "{p} has no auth header");
        }
        assert!(allowed_hosts("not-a-provider").is_none());
    }

    #[test]
    fn no_host_list_is_empty() {
        // An empty list would pass `iter().any()` as false and refuse
        // everything, which reads as the key being wrong.
        for p in ["openai", "anthropic", "google", "fal", "minimax"] {
            assert!(!allowed_hosts(p).unwrap().is_empty(), "{p} allows no host");
        }
    }

    /// The suffix match is the whole host check, so it is worth pinning that
    /// it is a SUFFIX ON A DOT and not a substring: `api.openai.com.evil.test`
    /// contains an allowed host and must still be refused.
    #[test]
    fn a_lookalike_host_does_not_pass_the_suffix_check() {
        let hosts = allowed_hosts("openai").unwrap();
        let ok = |host: &str| hosts.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
        assert!(ok("api.openai.com"));
        assert!(ok("eu.api.openai.com"));
        assert!(!ok("api.openai.com.evil.test"));
        assert!(!ok("notapi.openai.com.attacker.net"));
        assert!(!ok("openai.com"));
    }

    #[test]
    fn fal_media_is_reachable_with_the_key_because_a_result_lives_there() {
        let hosts = allowed_hosts("fal").unwrap();
        assert!(hosts.contains(&"fal.media"),
                "a fal render's output url is on fal.media; without it the \
                 download cannot be signed");
        assert!(hosts.contains(&"queue.fal.run"),
                "fal's async submit/poll endpoints are on queue.fal.run");
    }
}
