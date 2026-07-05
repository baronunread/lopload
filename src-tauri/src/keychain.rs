use serde::{Deserialize, Serialize};

const SERVICE: &str = "com.lopload";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credentials {
    #[serde(rename = "accessKey")]
    pub access_key: String,
    #[serde(rename = "secretKey")]
    pub secret_key: String,
}

impl Credentials {
    fn to_secret_json(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    fn from_secret_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| e.to_string())
    }
}

// ── Platform-specific keychain backends ────────────────────────────────

mod platform {
    use super::*;

    // macOS: Security.framework with data-protection keychain (no prompts).
    #[cfg(target_os = "macos")]
    mod imp {
        use super::*;
        use security_framework::passwords::*;

        pub fn set(connection_id: &str, creds: &Credentials) -> Result<(), String> {
            let json = creds.to_secret_json()?;
            let mut opts = PasswordOptions::new_generic_password(SERVICE, connection_id);
            opts.use_protected_keychain();
            opts.set_label("Lopload storage credentials");
            set_generic_password_options(json.as_bytes(), opts).map_err(|e| e.to_string())
        }

        pub fn get(connection_id: &str) -> Result<Credentials, String> {
            let pw = get_generic_password(SERVICE, connection_id)
                .map_err(|_| format!("no stored credentials for: {connection_id}"))?;
            let s = String::from_utf8(pw).map_err(|e| e.to_string())?;
            Credentials::from_secret_json(&s)
        }

        pub fn delete(connection_id: &str) -> Result<(), String> {
            let _ = delete_generic_password(SERVICE, connection_id);
            Ok(())
        }
    }

    // Windows + Linux: keyring crate (Credential Manager / Secret Service).
    #[cfg(not(target_os = "macos"))]
    mod imp {
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

    pub fn set(connection_id: &str, creds: &Credentials) -> Result<(), String> {
        imp::set(connection_id, creds)
    }

    pub fn get(connection_id: &str) -> Result<Credentials, String> {
        imp::get(connection_id)
    }

    pub fn delete(connection_id: &str) -> Result<(), String> {
        imp::delete(connection_id)
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────

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
    platform::set(&connection_id, &creds)
}

#[tauri::command]
pub fn keychain_get(
    connection_id: String,
) -> Result<Credentials, String> {
    platform::get(&connection_id)
}

#[tauri::command]
pub fn keychain_delete(
    connection_id: String,
) -> Result<(), String> {
    platform::delete(&connection_id)
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

    #[test]
    #[ignore]
    fn round_trips_through_real_keychain() {
        let connection_id = "lopload-test-connection-do-not-use";
        let creds = Credentials {
            access_key: "AKIATEST".to_string(),
            secret_key: "secret".to_string(),
        };

        platform::set(connection_id, &creds).expect("set");
        let back = platform::get(connection_id).expect("get");
        assert_eq!(back.access_key, "AKIATEST");
        assert_eq!(back.secret_key, "secret");
        platform::delete(connection_id).expect("delete");
        assert!(platform::get(connection_id).is_err());
    }
}
