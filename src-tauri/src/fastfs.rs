// Positional file writes whose bytes ride the IPC as a raw body.
//
// @tauri-apps/plugin-fs's `write` passes the chunk nested inside a JSON args
// object (`{ rid, data }`), and Tauri's IPC serializer turns a nested
// Uint8Array into `Array.from(val)` before JSON-stringifying it. A 2 MiB write
// therefore leaves the webview as roughly 9 MB of decimal text and is parsed
// back into bytes on this side — per 2 MiB written. At download speed that
// alone saturates the UI thread, which is why a running download made the app
// crawl.
//
// Tauri only takes its raw-bytes path when the payload is *itself* a
// TypedArray, so the chunk has to be the whole invoke argument and everything
// else has to travel as headers. That's the same trick plugin-fs reserves for
// its own `write_file` (which can't seek, so it's no use for ranged
// downloads). Here it costs one memcpy and one syscall per write.

use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};

use tauri::ipc::{InvokeBody, Request};

/// Writes `request`'s raw body at `offset` in the file named by the `path`
/// header (percent-encoded, as HTTP headers are ASCII-only). The file must
/// already exist at its final size — ranged downloads pre-allocate the temp
/// file so workers can write their own range into it.
///
/// Each call opens its own descriptor, so concurrent writes to non-overlapping
/// offsets in the same file don't share a seek position and need no locking.
#[tauri::command]
pub async fn write_at(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_at expects a raw byte body".to_string());
    };

    let headers = request.headers();
    let path = headers
        .get("path")
        .ok_or_else(|| "write_at is missing its path header".to_string())
        .and_then(|p| {
            percent_encoding::percent_decode(p.as_ref())
                .decode_utf8()
                .map_err(|_| "write_at path is not valid UTF-8".to_string())
        })?;
    let offset: u64 = headers
        .get("offset")
        .and_then(|o| o.to_str().ok())
        .and_then(|o| o.parse().ok())
        .ok_or_else(|| "write_at is missing a valid offset header".to_string())?;

    let mut file = OpenOptions::new()
        .write(true)
        .open(path.as_ref())
        .map_err(|e| format!("{path}: {e}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("{path}: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("{path}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write as _;

    use super::*;

    /// The command itself needs a webview to build a Request, so the tests
    /// cover the write behavior it delegates to: a positional write into a
    /// pre-allocated file, which is the part with the sharp edges.
    fn write_at_path(path: &std::path::Path, offset: u64, bytes: &[u8]) {
        let mut file = OpenOptions::new().write(true).open(path).expect("open");
        file.seek(SeekFrom::Start(offset)).expect("seek");
        file.write_all(bytes).expect("write");
    }

    fn allocated(dir: &std::path::Path, name: &str, size: u64) -> std::path::PathBuf {
        let path = dir.join(name);
        let file = fs::File::create(&path).expect("create");
        file.set_len(size).expect("truncate");
        path
    }

    #[test]
    fn writes_ranges_at_their_offsets_without_disturbing_the_rest() {
        let dir = std::env::temp_dir().join("lopload-fastfs-offsets");
        fs::create_dir_all(&dir).expect("mkdir");
        let path = allocated(&dir, "ranges.bin", 12);

        // Out of order, the way ranged download workers actually land.
        write_at_path(&path, 8, b"cccc");
        write_at_path(&path, 0, b"aaaa");
        write_at_path(&path, 4, b"bbbb");

        assert_eq!(fs::read(&path).expect("read"), b"aaaabbbbcccc");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn keeps_the_preallocated_length_rather_than_truncating_it() {
        let dir = std::env::temp_dir().join("lopload-fastfs-length");
        fs::create_dir_all(&dir).expect("mkdir");
        let path = allocated(&dir, "sized.bin", 1024);

        write_at_path(&path, 0, b"head");

        // Opening to write a single range must not truncate the file the
        // other ranges are still being written into.
        assert_eq!(fs::metadata(&path).expect("stat").len(), 1024);
        fs::remove_dir_all(&dir).ok();
    }
}
