// Widening the fs plugin's scope to a folder the app is about to write into.
//
// Tauri's fs scope grants exactly what the user pointed at and nothing more:
// the dialog plugin allows the file the save dialog returned, and the fs plugin
// allows dropped paths. A download needs more than that — it writes a
// `.lopload-download` sibling next to the destination, it creates subfolders
// under a chosen folder when a whole folder is downloaded, and it usually
// targets the download folder remembered from a previous run, which was never
// picked in this session at all.
//
// The static scope in `capabilities/default.json` only covers those by
// accident, when the destination happens to sit under `$HOME` (or a Unix mount
// point). On Windows there is no such catch-all: a destination on any drive
// other than the one holding the user profile is simply forbidden, and every
// download to it fails with "forbidden path".
//
// So the destination folder is granted here, at the moment the app writes into
// it. The grant is in-memory only — it lasts for this run and never reaches
// disk — and it stays tied to a folder the user chose as a destination.

use tauri::{AppHandle, Runtime};
use tauri_plugin_fs::FsExt;

/// Allows `path` and everything under it for the rest of this run.
#[tauri::command]
pub fn allow_fs_dir<R: Runtime>(app: AppHandle<R>, path: String) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| format!("{path}: {e}"))
}
