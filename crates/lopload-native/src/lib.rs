pub mod keychain;
#[cfg(feature = "s3")]
pub mod s3;
#[cfg(feature = "s3")]
pub mod transfer;

#[cfg(feature = "storage")]
use directories::ProjectDirs;
#[cfg(feature = "storage")]
use rusqlite::{Connection as Database, params};
#[cfg(feature = "storage")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "storage")]
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(feature = "storage")]
use uuid::Uuid;

#[cfg(feature = "storage")]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorageConnection {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub last_prefix: String,
    pub created_at: i64,
}

#[cfg(feature = "storage")]
pub struct NewStorageConnection {
    pub name: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
}

#[cfg(feature = "storage")]
pub struct UpdateStorageConnection {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
}

#[cfg(feature = "storage")]
pub fn save_connection(input: NewStorageConnection) -> Result<StorageConnection, String> {
    validate(&input)?;
    let connection = StorageConnection {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_string(),
        endpoint: input.endpoint.trim().trim_end_matches('/').to_string(),
        bucket: input.bucket.trim().to_string(),
        region: input.region.trim().to_string(),
        last_prefix: String::new(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Could not read the system clock".to_string())?
            .as_millis() as i64,
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

#[cfg(feature = "storage")]
pub fn list_connections() -> Result<Vec<StorageConnection>, String> {
    let database = open_database()?;
    let mut statement = database
        .prepare(
            "SELECT id, name, endpoint, bucket, region, last_prefix, created_at
             FROM connections ORDER BY created_at, name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(StorageConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                endpoint: row.get(2)?,
                bucket: row.get(3)?,
                region: row.get(4)?,
                last_prefix: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(feature = "storage")]
pub fn update_connection(input: UpdateStorageConnection) -> Result<StorageConnection, String> {
    validate_fields(&input.name, &input.endpoint, &input.bucket, &input.region)?;
    if input.access_key.is_some() != input.secret_key.is_some() {
        return Err("Enter both credential fields or leave both blank".into());
    }
    let database = open_database()?;
    let mut connection = connection_by_id(&database, &input.id)?
        .ok_or_else(|| "This storage connection no longer exists".to_string())?;
    connection.name = input.name.trim().to_string();
    connection.endpoint = input.endpoint.trim().trim_end_matches('/').to_string();
    connection.bucket = input.bucket.trim().to_string();
    connection.region = input.region.trim().to_string();

    let previous_credentials =
        if let (Some(access_key), Some(secret_key)) = (input.access_key, input.secret_key) {
            let previous = keychain::get(&connection.id).ok();
            keychain::set(
                &connection.id,
                &keychain::Credentials {
                    access_key,
                    secret_key,
                },
            )
            .map_err(|_| "Could not save credentials securely".to_string())?;
            Some(previous)
        } else {
            None
        };

    if database
        .execute(
            "UPDATE connections
         SET name = ?2, endpoint = ?3, bucket = ?4, region = ?5
         WHERE id = ?1",
            params![
                connection.id,
                connection.name,
                connection.endpoint,
                connection.bucket,
                connection.region
            ],
        )
        .is_err()
    {
        if let Some(previous) = previous_credentials {
            if let Some(previous) = previous {
                let _ = keychain::set(&connection.id, &previous);
            } else {
                let _ = keychain::delete(&connection.id);
            }
        }
        return Err("Could not update this storage".into());
    }

    Ok(connection)
}

#[cfg(feature = "storage")]
pub fn set_last_prefix(connection_id: &str, prefix: &str) -> Result<(), String> {
    let database = open_database()?;
    database
        .execute(
            "UPDATE connections SET last_prefix = ?2 WHERE id = ?1",
            params![connection_id, prefix],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(feature = "storage")]
pub fn delete_connection(connection_id: &str) -> Result<(), String> {
    keychain::delete(connection_id)?;
    let database = open_database()?;
    database
        .execute("DELETE FROM connections WHERE id = ?1", [connection_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(feature = "storage")]
fn validate(input: &NewStorageConnection) -> Result<(), String> {
    validate_fields(&input.name, &input.endpoint, &input.bucket, &input.region)?;
    if input.access_key.trim().is_empty() || input.secret_key.is_empty() {
        return Err("Enter both credential fields".into());
    }
    Ok(())
}

#[cfg(feature = "storage")]
fn validate_fields(name: &str, endpoint: &str, bucket: &str, region: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Enter a storage name".into());
    }
    if endpoint.trim().is_empty() {
        return Err("Enter an endpoint".into());
    }
    if !endpoint.trim().starts_with("https://") && !endpoint.trim().starts_with("http://") {
        return Err("Endpoint must start with http:// or https://".into());
    }
    if region.trim().is_empty() {
        return Err("Enter a region".into());
    }
    if bucket.trim().is_empty() {
        return Err("Enter a storage bucket".into());
    }
    Ok(())
}

#[cfg(feature = "storage")]
fn connection_by_id(
    database: &Database,
    connection_id: &str,
) -> Result<Option<StorageConnection>, String> {
    let mut statement = database
        .prepare(
            "SELECT id, name, endpoint, bucket, region, last_prefix, created_at
             FROM connections WHERE id = ?1",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([connection_id])
        .map_err(|error| error.to_string())?;
    let Some(row) = rows.next().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    Ok(Some(StorageConnection {
        id: row.get(0).map_err(|error| error.to_string())?,
        name: row.get(1).map_err(|error| error.to_string())?,
        endpoint: row.get(2).map_err(|error| error.to_string())?,
        bucket: row.get(3).map_err(|error| error.to_string())?,
        region: row.get(4).map_err(|error| error.to_string())?,
        last_prefix: row.get(5).map_err(|error| error.to_string())?,
        created_at: row.get(6).map_err(|error| error.to_string())?,
    }))
}

#[cfg(feature = "storage")]
fn insert_connection(connection: &StorageConnection) -> Result<(), String> {
    let database = open_database()?;
    database
        .execute(
            "INSERT INTO connections
             (id, name, endpoint, bucket, region, last_prefix, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                connection.id,
                connection.name,
                connection.endpoint,
                connection.bucket,
                connection.region,
                connection.last_prefix,
                connection.created_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(feature = "storage")]
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
                bucket TEXT NOT NULL DEFAULT '',
                region TEXT NOT NULL,
                last_prefix TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                remote_key TEXT NOT NULL,
                local_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                part_size INTEGER NOT NULL DEFAULT 8388608,
                upload_id TEXT,
                direction TEXT NOT NULL,
                state TEXT NOT NULL,
                error_class TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS transfer_parts (
                transfer_id TEXT NOT NULL,
                part_number INTEGER NOT NULL,
                etag TEXT NOT NULL,
                size INTEGER NOT NULL,
                PRIMARY KEY (transfer_id, part_number),
                FOREIGN KEY (transfer_id) REFERENCES transfers(id) ON DELETE CASCADE
            );",
        )
        .map_err(|error| error.to_string())?;
    ensure_column(&database, "bucket", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&database, "last_prefix", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&database, "created_at", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_table_column(
        &database,
        "transfers",
        "part_size",
        "INTEGER NOT NULL DEFAULT 8388608",
    )?;
    ensure_table_column(&database, "transfers", "upload_id", "TEXT")?;
    Ok(database)
}

#[cfg(feature = "storage")]
fn ensure_column(database: &Database, name: &str, declaration: &str) -> Result<(), String> {
    ensure_table_column(database, "connections", name, declaration)
}

#[cfg(feature = "storage")]
fn ensure_table_column(
    database: &Database,
    table: &str,
    name: &str,
    declaration: &str,
) -> Result<(), String> {
    let mut statement = database
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !columns.iter().any(|column| column == name) {
        database
            .execute(
                &format!("ALTER TABLE {table} ADD COLUMN {name} {declaration}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(all(test, feature = "storage"))]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_connection_fields() {
        let input = NewStorageConnection {
            name: String::new(),
            endpoint: String::new(),
            bucket: String::new(),
            region: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
        };
        assert_eq!(validate(&input).unwrap_err(), "Enter a storage name");
    }

    #[test]
    fn rejects_partial_credential_updates() {
        let input = UpdateStorageConnection {
            id: "missing".into(),
            name: "Storage".into(),
            endpoint: "https://example.com".into(),
            bucket: "files".into(),
            region: "auto".into(),
            access_key: Some("key".into()),
            secret_key: None,
        };
        assert_eq!(
            update_connection(input).unwrap_err(),
            "Enter both credential fields or leave both blank"
        );
    }
}
