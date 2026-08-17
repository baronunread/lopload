use crate::{StorageConnection, keychain};
use aws_sdk_s3::{
    Client,
    config::{
        Credentials as AwsCredentials, Region, RequestChecksumCalculation,
        ResponseChecksumValidation,
    },
    primitives::ByteStream,
};
use aws_smithy_http_client::hyper_014::HyperClientBuilder;
use hyper_rustls::HttpsConnectorBuilder;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::OnceLock};
use tokio::runtime::Runtime;

const TRASH_PREFIX: &str = ".lopload-trash/";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum RemoteEntryKind {
    File,
    Folder,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub kind: RemoteEntryKind,
    pub name: String,
    pub key: String,
    pub size: Option<u64>,
    pub last_modified: Option<i64>,
}

pub fn list_entries(
    connection: &StorageConnection,
    prefix: &str,
) -> Result<Vec<RemoteEntry>, String> {
    let connection = connection.clone();
    let prefix = prefix.to_string();
    runtime()?.block_on(async move { list_entries_async(&connection, &prefix).await })
}

pub fn test_connection(connection: &StorageConnection) -> Result<(), String> {
    let connection = connection.clone();
    runtime()?.block_on(async move {
        let client = client(&connection)?;
        client
            .list_objects_v2()
            .bucket(&connection.bucket)
            .max_keys(1)
            .send()
            .await
            .map_err(|_| "Could not connect to this storage".to_string())?;
        Ok(())
    })
}

pub fn test_connection_details(
    endpoint: &str,
    bucket: &str,
    region: &str,
    access_key: &str,
    secret_key: &str,
) -> Result<(), String> {
    if endpoint.trim().is_empty()
        || bucket.trim().is_empty()
        || region.trim().is_empty()
        || access_key.trim().is_empty()
        || secret_key.is_empty()
    {
        return Err("Fill in every connection field before testing".into());
    }
    let connection = StorageConnection {
        id: String::new(),
        name: String::new(),
        endpoint: endpoint.trim().trim_end_matches('/').to_string(),
        bucket: bucket.trim().to_string(),
        region: region.trim().to_string(),
        last_prefix: String::new(),
        created_at: 0,
    };
    let client =
        client_with_credentials(&connection, access_key.to_string(), secret_key.to_string());
    runtime()?.block_on(async move {
        client
            .list_objects_v2()
            .bucket(&connection.bucket)
            .max_keys(1)
            .send()
            .await
            .map_err(|_| "Could not connect to this storage".to_string())?;
        Ok(())
    })
}

pub fn create_folder(
    connection: &StorageConnection,
    prefix: &str,
    name: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a folder name".into());
    }
    if name.contains('/') {
        return Err("Folder names cannot contain /".into());
    }
    let connection = connection.clone();
    let key = format!("{prefix}{name}/");
    runtime()?.block_on(async move {
        client(&connection)?
            .put_object()
            .bucket(&connection.bucket)
            .key(key)
            .body(ByteStream::from_static(b""))
            .send()
            .await
            .map_err(|_| "Could not create this folder".to_string())?;
        Ok(())
    })
}

async fn list_entries_async(
    connection: &StorageConnection,
    prefix: &str,
) -> Result<Vec<RemoteEntry>, String> {
    let client = client(connection)?;
    list_entries_with_client(&client, &connection.bucket, prefix).await
}

async fn list_entries_with_client(
    client: &Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<RemoteEntry>, String> {
    let mut entries = BTreeMap::new();
    let mut continuation_token = None;

    loop {
        let response = client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .delimiter("/")
            .set_continuation_token(continuation_token)
            .send()
            .await
            .map_err(|_| "Could not load this storage".to_string())?;

        for common_prefix in response.common_prefixes() {
            let Some(key) = common_prefix.prefix() else {
                continue;
            };
            if key.starts_with(TRASH_PREFIX) {
                continue;
            }
            entries.insert(
                key.to_string(),
                RemoteEntry {
                    kind: RemoteEntryKind::Folder,
                    name: base_name(key),
                    key: key.to_string(),
                    size: None,
                    last_modified: None,
                },
            );
        }

        for object in response.contents() {
            let Some(key) = object.key() else {
                continue;
            };
            if key == prefix || key.ends_with('/') || key.starts_with(TRASH_PREFIX) {
                continue;
            }
            entries.insert(
                key.to_string(),
                RemoteEntry {
                    kind: RemoteEntryKind::File,
                    name: base_name(key),
                    key: key.to_string(),
                    size: object.size().and_then(|size| u64::try_from(size).ok()),
                    last_modified: object.last_modified().map(|date| date.secs() * 1000),
                },
            );
        }

        if response.is_truncated() != Some(true) {
            break;
        }
        continuation_token = response.next_continuation_token().map(str::to_string);
    }

    let mut entries = entries.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_folder = matches!(left.kind, RemoteEntryKind::Folder);
        let right_folder = matches!(right.kind, RemoteEntryKind::Folder);
        right_folder
            .cmp(&left_folder)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

pub(crate) fn client(connection: &StorageConnection) -> Result<Client, String> {
    let stored = keychain::get(&connection.id)
        .map_err(|_| "Stored credentials could not be read".to_string())?;
    Ok(client_with_credentials(
        connection,
        stored.access_key,
        stored.secret_key,
    ))
}

pub(crate) fn client_with_credentials(
    connection: &StorageConnection,
    access_key: String,
    secret_key: String,
) -> Client {
    let credentials = AwsCredentials::new(access_key, secret_key, None, None, "lopload-keychain");
    let connector = HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();
    let http_client = HyperClientBuilder::new().build(connector);
    let config = aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .region(Region::new(connection.region.clone()))
        .endpoint_url(connection.endpoint.clone())
        .force_path_style(true)
        .credentials_provider(credentials)
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .http_client(http_client)
        .build();
    Client::from_conf(config)
}

pub(crate) fn runtime() -> Result<&'static Runtime, String> {
    static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| Runtime::new().map_err(|_| "Could not start networking".to_string()))
        .as_ref()
        .map_err(Clone::clone)
}

fn base_name(key: &str) -> String {
    key.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(key)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn extracts_file_and_folder_names() {
        assert_eq!(base_name("photos/cat.png"), "cat.png");
        assert_eq!(base_name("photos/holidays/"), "holidays");
    }

    #[test]
    #[ignore]
    fn lists_real_minio_objects() {
        let bucket = format!("lopload-gpui-{}", Uuid::new_v4());
        let connection = StorageConnection {
            id: "integration-test".into(),
            name: "Integration test".into(),
            endpoint: "http://127.0.0.1:9400".into(),
            bucket: bucket.clone(),
            region: "us-east-1".into(),
            last_prefix: String::new(),
            created_at: 0,
        };
        let client = client_with_credentials(&connection, "minioadmin".into(), "minioadmin".into());
        runtime()
            .expect("runtime")
            .block_on(async {
                client.create_bucket().bucket(&bucket).send().await?;
                client
                    .put_object()
                    .bucket(&bucket)
                    .key("docs/readme.txt")
                    .body(ByteStream::from_static(b"hello"))
                    .send()
                    .await?;
                client
                    .put_object()
                    .bucket(&bucket)
                    .key("photo.jpg")
                    .body(ByteStream::from_static(b"image"))
                    .send()
                    .await?;

                let entries = list_entries_with_client(&client, &bucket, "")
                    .await
                    .expect("list");
                assert_eq!(entries.len(), 2);
                assert!(matches!(entries[0].kind, RemoteEntryKind::Folder));
                assert_eq!(entries[0].name, "docs");
                assert_eq!(entries[1].name, "photo.jpg");

                client
                    .delete_object()
                    .bucket(&bucket)
                    .key("docs/readme.txt")
                    .send()
                    .await?;
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key("photo.jpg")
                    .send()
                    .await?;
                client.delete_bucket().bucket(&bucket).send().await?;
                Ok::<_, aws_sdk_s3::Error>(())
            })
            .expect("MinIO round trip");
    }
}
