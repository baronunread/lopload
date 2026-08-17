use crate::open_database;
use rusqlite::params;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferTuning {
    pub preset: String,
    pub concurrent_files: u32,
    pub upload_parts_in_flight: u32,
    pub download_connections: u32,
    pub part_size_mib: u32,
}

impl Default for TransferTuning {
    fn default() -> Self {
        Self {
            preset: "normal".into(),
            concurrent_files: 3,
            upload_parts_in_flight: 4,
            download_connections: 4,
            part_size_mib: 8,
        }
    }
}

pub fn auto_update_enabled() -> Result<bool, String> {
    get("auto_update_enabled").map(|value| value.unwrap_or(true))
}

pub fn set_auto_update_enabled(enabled: bool) -> Result<(), String> {
    set("auto_update_enabled", &enabled)
}

pub fn theme_mode() -> Result<Option<ThemeMode>, String> {
    get("theme_mode")
}

pub fn set_theme_mode(mode: ThemeMode) -> Result<(), String> {
    set("theme_mode", &mode)
}

pub fn default_download_dir() -> Result<Option<String>, String> {
    Ok(get::<String>("default_download_dir")?)
}

pub fn set_default_download_dir(path: Option<&str>) -> Result<(), String> {
    match path {
        Some(path) => set("default_download_dir", &path),
        None => remove("default_download_dir"),
    }
}

pub fn transfer_tuning() -> Result<TransferTuning, String> {
    get("transfer_tuning").map(|value| value.unwrap_or_default())
}

pub fn set_transfer_tuning(tuning: &TransferTuning) -> Result<(), String> {
    if tuning.concurrent_files == 0
        || tuning.upload_parts_in_flight == 0
        || tuning.download_connections == 0
        || !(5..=512).contains(&tuning.part_size_mib)
    {
        return Err("Choose valid transfer settings".into());
    }
    set("transfer_tuning", tuning)
}

fn get<T: DeserializeOwned>(key: &str) -> Result<Option<T>, String> {
    let database = open_database()?;
    let mut statement = database
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([key]).map_err(|error| error.to_string())?;
    let Some(row) = rows.next().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let value = row.get::<_, String>(0).map_err(|error| error.to_string())?;
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn set<T: Serialize + ?Sized>(key: &str, value: &T) -> Result<(), String> {
    let value = serde_json::to_string(value).map_err(|error| error.to_string())?;
    open_database()?
        .execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn remove(key: &str) -> Result<(), String> {
    open_database()?
        .execute("DELETE FROM settings WHERE key = ?1", [key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_concurrency() {
        let tuning = TransferTuning {
            concurrent_files: 0,
            ..TransferTuning::default()
        };
        assert_eq!(
            set_transfer_tuning(&tuning).unwrap_err(),
            "Choose valid transfer settings"
        );
    }

    #[test]
    fn serializes_theme_modes_as_stable_setting_values() {
        assert_eq!(serde_json::to_string(&ThemeMode::Light).unwrap(), "\"light\"");
        assert_eq!(
            serde_json::from_str::<ThemeMode>("\"dark\"").unwrap(),
            ThemeMode::Dark
        );
    }
}
