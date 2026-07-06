// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod keychain;
mod tray;

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
        .setup(|app| {
            tray::setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            keychain::keychain_set,
            keychain::keychain_get,
            keychain::keychain_delete,
            tray::tray_set_progress,
            tray::tray_set_status,
            tray::set_badge_count,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
