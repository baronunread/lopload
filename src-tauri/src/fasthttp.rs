// HTTP sends whose request body rides the IPC as a raw body.
//
// @tauri-apps/plugin-http's `fetch` turns the body into
// `Array.from(new Uint8Array(buffer))` and passes it nested inside its
// `clientConfig` argument, so Tauri's IPC serializer JSON-stringifies it. An
// 8 MiB UploadPart body therefore becomes an 8.4-million-element JS array and
// then ~30 MB of decimal text, built and parsed on the UI thread, once per
// part — several at a time at the default upload concurrency. That is the
// upload-side twin of the download bug `fastfs::write_at` exists to avoid:
// Tauri only takes its raw-bytes path when the payload *is* the TypedArray.
//
// So here too the bytes are the whole invoke argument and everything else
// travels as headers. Only body-bearing S3 requests (PutObject, UploadPart)
// route through this command; their responses are empty or a few hundred bytes
// of XML, which is why the reply can go back as an ordinary serialized struct.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_http::reqwest;
use tokio::sync::oneshot;

/// Error message for a send the webview aborted (pause, cancel, quit). The JS
/// side turns its own AbortSignal into an AbortError before this is ever seen,
/// so it only has to be unmistakable in a log.
const CANCELLED: &str = "http_send: request cancelled";

/// One client for the process. An upload fires many requests at the same
/// endpoint, and a shared client pools their connections instead of paying a
/// fresh TLS handshake per part (plugin-http builds a client per call).
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Sends currently in flight, plus the ids of sends whose cancel arrived
/// before they did. Both are needed because `http_cancel` and `http_send`
/// cross the IPC as separate invokes and can land in either order: without the
/// early set, a cancel that wins the race would be dropped and the part would
/// upload anyway.
#[derive(Default)]
struct Registry {
    in_flight: HashMap<u64, oneshot::Sender<()>>,
    cancelled_early: HashSet<u64>,
}

fn registry() -> MutexGuard<'static, Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    let lock = REGISTRY.get_or_init(|| Mutex::new(Registry::default()));
    // A panic while holding this lock would only ever leave the maps as they
    // were; recovering beats poisoning every later upload.
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug)]
struct Meta {
    id: u64,
    method: reqwest::Method,
    url: String,
    headers: Vec<(String, String)>,
}

/// Reads the request metadata out of the IPC headers. Values are
/// percent-encoded by the caller because HTTP headers are ASCII-only and URLs,
/// keys and signatures are not.
fn parse_meta(headers: &HeaderMap) -> Result<Meta, String> {
    let value = |name: &str| -> Result<String, String> {
        let raw = headers
            .get(name)
            .ok_or_else(|| format!("http_send is missing its {name} header"))?;
        percent_encoding::percent_decode(raw.as_ref())
            .decode_utf8()
            .map(|decoded| decoded.into_owned())
            .map_err(|_| format!("http_send's {name} header is not valid UTF-8"))
    };

    let id = value("x-request-id")?
        .parse()
        .map_err(|_| "http_send has an invalid x-request-id header".to_string())?;
    let method = reqwest::Method::from_bytes(value("x-method")?.as_bytes())
        .map_err(|_| "http_send has an invalid x-method header".to_string())?;
    let headers = serde_json::from_str(&value("x-headers")?)
        .map_err(|e| format!("http_send could not parse its x-headers header: {e}"))?;

    Ok(Meta {
        id,
        method,
        url: value("x-url")?,
        headers,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    /// Empty for an UploadPart/PutObject success; a small XML document when S3
    /// rejects the request. Serializing it as JSON numbers is only affordable
    /// because of that — see the module comment.
    body: Vec<u8>,
}

/// Sends `request`'s raw body to the URL in its headers and returns the whole
/// response. Cancellable via [`http_cancel`] with the same `x-request-id`.
#[tauri::command]
pub async fn http_send(request: Request<'_>) -> Result<Reply, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("http_send expects a raw byte body".to_string());
    };
    let meta = parse_meta(request.headers())?;

    let mut builder = client().request(meta.method, &meta.url);
    for (name, value) in &meta.headers {
        builder = builder.header(name, value);
    }
    // The one copy this path makes: out of the IPC buffer and into the
    // request. The bytes are never turned into text anywhere along the way.
    let builder = builder.body(body.clone());

    let (cancel, cancelled) = oneshot::channel();
    {
        let mut registry = registry();
        if registry.cancelled_early.remove(&meta.id) {
            return Err(CANCELLED.to_string());
        }
        registry.in_flight.insert(meta.id, cancel);
    }

    let send = async {
        let response = builder.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        // Reading the body is part of the send: dropping the response early
        // would leave the connection unusable for the next part.
        let body = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok(Reply {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_string(),
            headers,
            body,
        })
    };

    // Dropping the send future is what actually tears the request down; the
    // channel just tells us when to do it.
    let result = tokio::select! {
        sent = send => sent,
        _ = cancelled => Err(CANCELLED.to_string()),
    };
    registry().in_flight.remove(&meta.id);
    result
}

/// Aborts the in-flight [`http_send`] with this id, or remembers the cancel if
/// it arrives first.
#[tauri::command]
pub fn http_cancel(id: u64) {
    let mut registry = registry();
    match registry.in_flight.remove(&id) {
        Some(cancel) => {
            let _ = cancel.send(());
        }
        None => {
            registry.cancelled_early.insert(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Building a Request needs a webview, so the tests cover the two pieces
    /// the command delegates to: header parsing and the cancel registry.
    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                tauri::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                tauri::http::HeaderValue::from_str(value).expect("header value"),
            );
        }
        map
    }

    fn signed_request_headers() -> HeaderMap {
        headers(&[
            ("x-request-id", "7"),
            ("x-method", "PUT"),
            // A real key: spaces and non-ASCII, which is why these are encoded.
            (
                "x-url",
                "https%3A%2F%2Fs3.example.com%2Fbucket%2Fmy%20r%C3%A9sum%C3%A9.pdf%3FpartNumber%3D2",
            ),
            (
                "x-headers",
                "%5B%5B%22authorization%22%2C%22AWS4-HMAC-SHA256%20Credential%3Dabc%22%5D%5D",
            ),
        ])
    }

    #[test]
    fn decodes_the_url_and_signed_headers_the_webview_encoded() {
        let meta = parse_meta(&signed_request_headers()).expect("parse");

        assert_eq!(meta.id, 7);
        assert_eq!(meta.method, reqwest::Method::PUT);
        assert_eq!(
            meta.url,
            "https://s3.example.com/bucket/my résumé.pdf?partNumber=2"
        );
        assert_eq!(
            meta.headers,
            vec![(
                "authorization".to_string(),
                "AWS4-HMAC-SHA256 Credential=abc".to_string()
            )]
        );
    }

    #[test]
    fn refuses_a_request_that_is_missing_its_metadata() {
        let err = parse_meta(&headers(&[("x-request-id", "7")])).expect_err("should fail");
        assert!(err.contains("x-method"), "{err}");
    }

    #[test]
    fn a_cancel_that_arrives_before_its_send_still_cancels_it() {
        // The pause button can beat the invoke it's cancelling across the IPC.
        http_cancel(4242);

        let mut registry = registry();
        assert!(
            registry.cancelled_early.remove(&4242),
            "an unknown id must be remembered so http_send can bail on it"
        );
    }

    #[test]
    fn a_cancel_for_an_in_flight_send_fires_its_channel() {
        let (cancel, cancelled) = oneshot::channel();
        registry().in_flight.insert(99, cancel);

        http_cancel(99);

        assert!(cancelled.blocking_recv().is_ok(), "send should be cancelled");
        assert!(!registry().in_flight.contains_key(&99), "entry should be gone");
    }
}
