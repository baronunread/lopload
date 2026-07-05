//! OS keychain access for storage connection credentials.
//!
//! Two backends, selected at build time:
//!
//! - **Native keychain** (`native_keychain` cfg): OS keychain via the `keyring`
//!   crate — macOS Keychain, Windows Credential Manager, Linux Secret Service.
//! - **Development store** (no cfg): file-based JSON store under the app data
//!   directory, permissions 0o600 on Unix. No OS keychain is ever touched.
//!
//! Backend selection (priority order):
//! 1. `LOPLOAD_KEYCHAIN_BACKEND=native|dev` env var at runtime (testing override).
//! 2. Build-time cfg: `native_keychain` set by [`build.rs`] for release builds
//!    or when `LOPLOAD_NATIVE_KEYCHAIN=1` is set.
//! 3. Default: dev store (always safe).
//!
//! No secrets ever touch SQLite or disk in plaintext in production — see
//! PLAN.md item 4.

use serde::{Deserialize, Serialize};

#[cfg(native_keychain)]
const SERVICE: &str = "com.lopload.app";

/// Credentials for a single storage connection, as handed to/from the
/// frontend. Field names are camelCase on the JS side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credentials {
    #[serde(rename = "accessKey")]
    pub access_key: String,
    #[serde(rename = "secretKey")]
    pub secret_key: String,
}

impl Credentials {
    #[cfg(any(native_keychain, test))]
    fn to_secret_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    #[cfg(any(native_keychain, test))]
    fn from_secret_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }
}

// ── Backend selection ──────────────────────────────────────────────────

/// Returns `true` when the native OS keychain should be used.
///
/// Priority:
///   1. Runtime env var `LOPLOAD_KEYCHAIN_BACKEND` (for testing)
///   2. Build-time `#[cfg(native_keychain)]` (set by build.rs)
///   3. Default: `false` (dev store)
fn use_native_keychain() -> bool {
    if let Ok(val) = std::env::var("LOPLOAD_KEYCHAIN_BACKEND") {
        match val.as_str() {
            "native" => return true,
            "dev" => return false,
            _ => {}
        }
    }
    #[cfg(native_keychain)]
    return true;
    #[cfg(not(native_keychain))]
    return false;
}

// ── Native keychain backend (production) ───────────────────────────────
//
// This module is only compiled when `#[cfg(native_keychain)]` is set, which
// happens automatically for release builds or when `LOPLOAD_NATIVE_KEYCHAIN=1`
// is present in the environment at build time (see build.rs).

#[cfg(native_keychain)]
mod native {
    use super::*;
    use keyring::Entry;

    pub fn set(connection_id: &str, creds: &Credentials) -> Result<(), String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())?;
        let json = creds.to_secret_json()?;
        entry.set_password(&json).map_err(|e| e.to_string())
    }

    pub fn get(connection_id: &str) -> Result<Credentials, String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())?;
        let json = entry.get_password().map_err(|e| e.to_string())?;
        Credentials::from_secret_json(&json)
    }

    pub fn delete(connection_id: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ── Development store (file-based, no OS keychain) ─────────────────────
//
// Always compiled as a fallback. On macOS, this avoids the repeated Keychain
// prompts that appear with ad-hoc signed development binaries.

mod dev {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    fn file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join("dev-credentials.json"))
    }

    fn load(app: &tauri::AppHandle) -> Result<HashMap<String, Credentials>, String> {
        let path = file_path(app)?;
        match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn save(app: &tauri::AppHandle, map: &HashMap<String, Credentials>) -> Result<(), String> {
        let path = file_path(app)?;
        let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn set(app: &tauri::AppHandle, id: &str, creds: &Credentials) -> Result<(), String> {
        let mut map = load(app)?;
        map.insert(id.to_string(), creds.clone());
        save(app, &map)
    }

    pub fn get(app: &tauri::AppHandle, id: &str) -> Result<Credentials, String> {
        load(app)?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("no stored credentials for: {id}"))
    }

    pub fn delete(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
        let mut map = load(app)?;
        if map.remove(id).is_some() {
            save(app, &map)?;
        }
        Ok(())
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────

/// Store the access key + secret key for a connection as one JSON secret.
#[tauri::command]
pub fn keychain_set(
    app: tauri::AppHandle,
    connection_id: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    let creds = Credentials {
        access_key,
        secret_key,
    };

    if use_native_keychain() {
        #[cfg(native_keychain)]
        return native::set(&connection_id, &creds);
        #[cfg(not(native_keychain))]
        return Err("Native keychain not compiled. Rebuild with LOPLOAD_NATIVE_KEYCHAIN=1.".into());
    }

    dev::set(&app, &connection_id, &creds)
}

/// Retrieve the access key + secret key for a connection.
#[tauri::command]
pub fn keychain_get(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<Credentials, String> {
    if use_native_keychain() {
        #[cfg(native_keychain)]
        return native::get(&connection_id);
        #[cfg(not(native_keychain))]
        return Err("Native keychain not compiled. Rebuild with LOPLOAD_NATIVE_KEYCHAIN=1.".into());
    }

    dev::get(&app, &connection_id)
}

/// Delete the stored credentials for a connection.
///
/// A missing entry is treated as success so that deleting a connection whose
/// credentials never reached the keychain does not block the operation.
#[tauri::command]
pub fn keychain_delete(
    app: tauri::AppHandle,
    connection_id: String,
) -> Result<(), String> {
    if use_native_keychain() {
        #[cfg(native_keychain)]
        return native::delete(&connection_id);
        #[cfg(not(native_keychain))]
        return Err("Native keychain not compiled. Rebuild with LOPLOAD_NATIVE_KEYCHAIN=1.".into());
    }

    dev::delete(&app, &connection_id)
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_credentials_through_json() {
        let creds = Credentials {
            access_key: "AKIAEXAMPLE".to_string(),
            secret_key: "s3cr3t/with+special=chars".to_string(),
        };
        let json = creds.to_secret_json().expect("serialize");
        let back = Credentials::from_secret_json(&json).expect("deserialize");
        assert_eq!(creds, back);
    }

    #[test]
    fn serializes_with_camel_case_field_names() {
        let creds = Credentials {
            access_key: "AK".to_string(),
            secret_key: "SK".to_string(),
        };
        let json = creds.to_secret_json().expect("serialize");
        assert!(json.contains("\"accessKey\":\"AK\""));
        assert!(json.contains("\"secretKey\":\"SK\""));
        assert!(!json.contains("access_key"));
        assert!(!json.contains("secret_key"));
    }

    #[test]
    fn rejects_malformed_json() {
        let err = Credentials::from_secret_json("not json").unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn rejects_json_missing_fields() {
        let err = Credentials::from_secret_json("{\"accessKey\":\"AK\"}").unwrap_err();
        assert!(!err.is_empty());
    }

    /// This test touches the real OS keychain and is ignored by default.
    #[test]
    #[ignore]
    fn round_trips_through_real_keychain() {
        // The native module is only compiled with `cfg(native_keychain)`.
        // Without it this test can't compile, so we guard the entire body.
        #[cfg(not(native_keychain))]
        panic!("This test requires a build with native_keychain cfg (LOPLOAD_NATIVE_KEYCHAIN=1).");

        #[cfg(native_keychain)]
        {
            let connection_id = "lopload-test-connection-do-not-use";
            let creds = Credentials {
                access_key: "AKIATEST".to_string(),
                secret_key: "secret".to_string(),
            };

            native::set(connection_id, &creds).expect("set");
            let back = native::get(connection_id).expect("get");
            assert_eq!(back.access_key, "AKIATEST");
            assert_eq!(back.secret_key, "secret");
            native::delete(connection_id).expect("delete");
            assert!(native::get(connection_id).is_err());
        }
    }
}
