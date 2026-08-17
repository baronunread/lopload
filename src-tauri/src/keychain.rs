use lopload_native::keychain::{self, Credentials};

#[tauri::command]
pub fn keychain_set(
    connection_id: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    keychain::set(
        &connection_id,
        &Credentials {
            access_key,
            secret_key,
        },
    )
}

#[tauri::command]
pub fn keychain_get(connection_id: String) -> Result<Credentials, String> {
    keychain::get(&connection_id)
}

#[tauri::command]
pub fn keychain_delete(connection_id: String) -> Result<(), String> {
    keychain::delete(&connection_id)
}
