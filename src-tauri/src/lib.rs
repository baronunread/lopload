// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod fastfs;
mod fasthttp;
mod keychain;
#[cfg(debug_assertions)]
mod selftest;
mod tray;

#[tauri::command]
fn is_portable_app() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
        .map(|name| name.contains("portable"))
        .unwrap_or(false)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            tray::setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            is_portable_app,
            fastfs::write_at,
            fasthttp::http_send,
            fasthttp::http_cancel,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            tray::tray_set_progress,
            tray::tray_set_status,
            tray::tray_set_connections,
            tray::set_badge_count,
            #[cfg(debug_assertions)]
            selftest::selftest_log,
            #[cfg(debug_assertions)]
            selftest::selftest_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
