pub mod keychain;

use directories::ProjectDirs;
use rusqlite::{Connection as Database, params};
use serde::{Deserialize, Serialize};
use std::fs;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageConnection {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub region: String,
}

pub struct NewStorageConnection {
    pub name: String,
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
}

pub fn save_connection(input: NewStorageConnection) -> Result<StorageConnection, String> {
    validate(&input)?;
    let connection = StorageConnection {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_string(),
        endpoint: input.endpoint.trim().trim_end_matches('/').to_string(),
        region: input.region.trim().to_string(),
    };
    let credentials = keychain::Credentials {
        access_key: input.access_key,
        secret_key: input.secret_key,
    };

    keychain::set(&connection.id, &credentials)
        .map_err(|_| "Could not save credentials securely".to_string())?;
    if insert_connection(&connection).is_err() {
        let _ = keychain::delete(&connection.id);
        return Err("Could not save this storage".into());
    }

    Ok(connection)
}

pub fn list_connections() -> Result<Vec<StorageConnection>, String> {
    let database = open_database()?;
    let mut statement = database
        .prepare("SELECT id, name, endpoint, region FROM connections ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(StorageConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                endpoint: row.get(2)?,
                region: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn validate(input: &NewStorageConnection) -> Result<(), String> {
    if input.name.trim().is_empty() {
        return Err("Enter a storage name".into());
    }
    if input.endpoint.trim().is_empty() {
        return Err("Enter an endpoint".into());
    }
    if !input.endpoint.trim().starts_with("https://")
        && !input.endpoint.trim().starts_with("http://")
    {
        return Err("Endpoint must start with http:// or https://".into());
    }
    if input.region.trim().is_empty() {
        return Err("Enter a region".into());
    }
    if input.access_key.trim().is_empty() || input.secret_key.is_empty() {
        return Err("Enter both credential fields".into());
    }
    Ok(())
}

fn insert_connection(connection: &StorageConnection) -> Result<(), String> {
    let database = open_database()?;
    database
        .execute(
            "INSERT INTO connections (id, name, endpoint, region) VALUES (?1, ?2, ?3, ?4)",
            params![
                connection.id,
                connection.name,
                connection.endpoint,
                connection.region
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn open_database() -> Result<Database, String> {
    let project = ProjectDirs::from("com", "Lopload", "Lopload")
        .ok_or_else(|| "Could not find the application data directory".to_string())?;
    fs::create_dir_all(project.data_dir()).map_err(|error| error.to_string())?;
    let database = Database::open(project.data_dir().join("lopload-gpui.sqlite"))
        .map_err(|error| error.to_string())?;
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                region TEXT NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;
    Ok(database)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_connection_fields() {
        let input = NewStorageConnection {
            name: String::new(),
            endpoint: String::new(),
            region: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
        };
        assert_eq!(validate(&input).unwrap_err(), "Enter a storage name");
    }
}
