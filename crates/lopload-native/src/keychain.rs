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
        serde_json::to_string(self).map_err(|error| error.to_string())
    }

    fn from_secret_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    pub fn set(connection_id: &str, credentials: &Credentials) -> Result<(), String> {
        let json = credentials.to_secret_json()?;
        set_generic_password(SERVICE, connection_id, json.as_bytes())
            .map_err(|error| error.to_string())
    }

    pub fn get(connection_id: &str) -> Result<Credentials, String> {
        let password = get_generic_password(SERVICE, connection_id)
            .map_err(|_| format!("no stored credentials for: {connection_id}"))?;
        let json = String::from_utf8(password).map_err(|error| error.to_string())?;
        Credentials::from_secret_json(&json)
    }

    pub fn delete(connection_id: &str) -> Result<(), String> {
        let _ = delete_generic_password(SERVICE, connection_id);
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    use keyring::Entry;

    pub fn set(connection_id: &str, credentials: &Credentials) -> Result<(), String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|error| error.to_string())?;
        let json = credentials.to_secret_json()?;
        entry.set_password(&json).map_err(|error| error.to_string())
    }

    pub fn get(connection_id: &str) -> Result<Credentials, String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|error| error.to_string())?;
        let json = entry.get_password().map_err(|error| error.to_string())?;
        Credentials::from_secret_json(&json)
    }

    pub fn delete(connection_id: &str) -> Result<(), String> {
        let entry = Entry::new(SERVICE, connection_id).map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

pub fn set(connection_id: &str, credentials: &Credentials) -> Result<(), String> {
    platform::set(connection_id, credentials)
}

pub fn get(connection_id: &str) -> Result<Credentials, String> {
    platform::get(connection_id)
}

pub fn delete(connection_id: &str) -> Result<(), String> {
    platform::delete(connection_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_credentials_through_json() {
        let credentials = Credentials {
            access_key: "AKIAEXAMPLE".to_string(),
            secret_key: "s3cr3t/with+special=chars".to_string(),
        };
        let json = credentials.to_secret_json().expect("serialize");
        assert_eq!(
            Credentials::from_secret_json(&json).expect("deserialize"),
            credentials
        );
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(Credentials::from_secret_json("not json").is_err());
    }

    #[test]
    fn serializes_with_camel_case_field_names() {
        let credentials = Credentials {
            access_key: "AK".to_string(),
            secret_key: "SK".to_string(),
        };
        let json = credentials.to_secret_json().expect("serialize");
        assert!(json.contains("\"accessKey\":\"AK\""));
        assert!(json.contains("\"secretKey\":\"SK\""));
        assert!(!json.contains("access_key"));
    }

    #[test]
    fn rejects_json_missing_fields() {
        assert!(Credentials::from_secret_json("{\"accessKey\":\"AK\"}").is_err());
    }

    #[test]
    #[ignore]
    fn round_trips_through_real_keychain() {
        let connection_id = "lopload-test-connection-do-not-use";
        let credentials = Credentials {
            access_key: "AKIATEST".to_string(),
            secret_key: "secret".to_string(),
        };
        set(connection_id, &credentials).expect("set");
        assert_eq!(get(connection_id).expect("get"), credentials);
        delete(connection_id).expect("delete");
        assert!(get(connection_id).is_err());
    }
}
