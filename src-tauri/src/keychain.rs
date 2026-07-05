//! OS keychain access for storage connection credentials.
//!
//! Access key + secret key are stored as a single JSON secret under the
//! service name `com.lopload.app`, keyed by the connection id (the
//! "account" in keychain terms). No secrets ever touch SQLite or disk in
//! plaintext — see PLAN.md item 4.

use keyring::Entry;
use serde::{Deserialize, Serialize};

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
    /// Serialize to the JSON blob stored as the keychain secret.
    /// Isolated from the keyring crate so it can be unit tested without
    /// touching the real OS keychain.
    fn to_secret_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    /// Deserialize the JSON blob read back from the keychain secret.
    fn from_secret_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }
}

fn entry_for(connection_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, connection_id).map_err(|e| e.to_string())
}

/// Store the access key + secret key for a connection as one JSON secret.
#[tauri::command]
pub fn keychain_set(
    connection_id: String,
    access_key: String,
    secret_key: String,
) -> Result<(), String> {
    let creds = Credentials {
        access_key,
        secret_key,
    };
    let json = creds.to_secret_json()?;
    let entry = entry_for(&connection_id)?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

/// Retrieve the access key + secret key for a connection.
#[tauri::command]
pub fn keychain_get(connection_id: String) -> Result<Credentials, String> {
    let entry = entry_for(&connection_id)?;
    let json = entry.get_password().map_err(|e| e.to_string())?;
    Credentials::from_secret_json(&json)
}

/// Delete the stored credentials for a connection.
#[tauri::command]
pub fn keychain_delete(connection_id: String) -> Result<(), String> {
    let entry = entry_for(&connection_id)?;
    entry.delete_credential().map_err(|e| e.to_string())
}

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

    /// This test touches the real OS keychain and cannot run headlessly in
    /// CI (no keychain/secret-service available) or via a plain `cargo test`
    /// invocation on a dev machine either — macOS shows an interactive
    /// "<app> wants to use your confidential information" prompt on first
    /// access from a new/unsigned binary, which has no session to answer it
    /// outside a real (signed or at least interactively-launched) app. Run
    /// manually with `cargo test -- --ignored` and approve the OS prompt if
    /// one appears, or rely on manual verification through the running app.
    #[test]
    #[ignore]
    fn round_trips_through_real_keychain() {
        let connection_id = "lopload-test-connection-do-not-use";
        keychain_set(
            connection_id.to_string(),
            "AKIATEST".to_string(),
            "secret".to_string(),
        )
        .expect("set");
        let creds = keychain_get(connection_id.to_string()).expect("get");
        assert_eq!(creds.access_key, "AKIATEST");
        assert_eq!(creds.secret_key, "secret");
        keychain_delete(connection_id.to_string()).expect("delete");
        assert!(keychain_get(connection_id.to_string()).is_err());
    }
}
