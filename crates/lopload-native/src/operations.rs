use crate::{StorageConnection, s3};
use aws_sdk_s3::{
    Client,
    presigning::PresigningConfig,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart, Delete, ObjectIdentifier},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

const TRASH_PREFIX: &str = ".lopload-trash/";
const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const COPY_MULTIPART_THRESHOLD: u64 = 64 * 1024 * 1024;
const COPY_PART_SIZE: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrashItem {
    pub id: String,
    pub original_key: String,
    pub name: String,
    pub is_folder: bool,
    pub deleted_at: i64,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RemoteFile {
    pub key: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OperationProgress {
    pub completed_items: usize,
    pub total_items: usize,
    pub completed_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TrashSweepStats {
    pub scanned: usize,
    pub purged: usize,
    pub errors: usize,
}

#[derive(Clone)]
struct ObjectRef {
    key: String,
    size: u64,
    modified: Option<i64>,
}

fn report_progress(
    on_progress: &mut dyn FnMut(OperationProgress),
    completed_items: usize,
    total_items: usize,
    completed_bytes: u64,
    total_bytes: u64,
) {
    on_progress(OperationProgress {
        completed_items,
        total_items,
        completed_bytes,
        total_bytes,
    });
}

pub fn folder_info(
    connection: &StorageConnection,
    prefix: &str,
) -> Result<(u64, Option<i64>), String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        let objects = list_objects(&client, connection, prefix).await?;
        Ok((
            objects.iter().map(|object| object.size).sum(),
            objects.iter().filter_map(|object| object.modified).max(),
        ))
    })
}

pub fn files_in_folder(
    connection: &StorageConnection,
    prefix: &str,
) -> Result<Vec<RemoteFile>, String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        Ok(list_objects(&client, connection, prefix)
            .await?
            .into_iter()
            .filter(|object| !object.key.ends_with('/'))
            .map(|object| RemoteFile {
                key: object.key,
                size: object.size,
            })
            .collect())
    })
}

pub fn list_folders(connection: &StorageConnection) -> Result<Vec<String>, String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        let objects = list_objects(&client, connection, "").await?;
        let mut folders = BTreeSet::new();
        folders.insert(String::new());
        for object in objects {
            if object.key.starts_with(TRASH_PREFIX) {
                continue;
            }
            let mut prefix = String::new();
            let mut segments = object.key.split('/').peekable();
            while let Some(segment) = segments.next() {
                if segment.is_empty() || segments.peek().is_none() {
                    break;
                }
                prefix.push_str(segment);
                prefix.push('/');
                folders.insert(prefix.clone());
            }
        }
        Ok(folders.into_iter().collect())
    })
}

pub fn move_entry(
    connection: &StorageConnection,
    from_key: &str,
    is_folder: bool,
    destination_prefix: &str,
) -> Result<(), String> {
    move_entry_with_progress(connection, from_key, is_folder, destination_prefix, |_| {})
}

pub fn move_entry_with_progress(
    connection: &StorageConnection,
    from_key: &str,
    is_folder: bool,
    destination_prefix: &str,
    mut on_progress: impl FnMut(OperationProgress),
) -> Result<(), String> {
    let name = base_name(from_key);
    let destination = format!(
        "{destination_prefix}{name}{}",
        if is_folder { "/" } else { "" }
    );
    validate_destination(from_key, &destination)?;
    if is_folder && destination_prefix.starts_with(from_key) {
        return Err("A folder can't be moved inside itself".into());
    }
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(move_entry_with_client(
        &client,
        connection,
        from_key,
        is_folder,
        &destination,
        &mut on_progress,
    ))
}

async fn move_entry_with_client(
    client: &Client,
    connection: &StorageConnection,
    from_key: &str,
    is_folder: bool,
    destination: &str,
    on_progress: &mut dyn FnMut(OperationProgress),
) -> Result<(), String> {
    let occupied = if is_folder {
        client
            .list_objects_v2()
            .bucket(&connection.bucket)
            .prefix(destination)
            .max_keys(1)
            .send()
            .await
            .map_err(|_| "The destination could not be checked".to_string())?
            .key_count()
            .unwrap_or_default()
            > 0
    } else {
        client
            .head_object()
            .bucket(&connection.bucket)
            .key(destination)
            .send()
            .await
            .is_ok()
    };
    if occupied {
        return Err("Something's already there — move skipped.".into());
    }
    if is_folder {
        let objects = list_objects(client, connection, from_key).await?;
        let total_items = objects.len();
        let total_bytes = objects.iter().map(|object| object.size).sum();
        let mut completed_items = 0;
        let mut completed_bytes = 0;
        on_progress(OperationProgress {
            completed_items,
            total_items,
            completed_bytes,
            total_bytes,
        });
        for object in &objects {
            let target = format!("{destination}{}", &object.key[from_key.len()..]);
            copy_object(client, connection, object, &target).await?;
            completed_items += 1;
            completed_bytes += object.size;
            on_progress(OperationProgress {
                completed_items,
                total_items,
                completed_bytes,
                total_bytes,
            });
        }
        delete_keys(
            client,
            connection,
            objects.into_iter().map(|object| object.key).collect(),
        )
        .await
    } else {
        let head = client
            .head_object()
            .bucket(&connection.bucket)
            .key(from_key)
            .send()
            .await
            .map_err(|_| "This file could not be read".to_string())?;
        let size = head
            .content_length()
            .and_then(|size| u64::try_from(size).ok())
            .unwrap_or_default();
        on_progress(OperationProgress {
            completed_items: 0,
            total_items: 1,
            completed_bytes: 0,
            total_bytes: size,
        });
        copy_object(
            client,
            connection,
            &ObjectRef {
                key: from_key.to_string(),
                size,
                modified: None,
            },
            destination,
        )
        .await?;
        on_progress(OperationProgress {
            completed_items: 1,
            total_items: 1,
            completed_bytes: size,
            total_bytes: size,
        });
        delete_key(client, connection, from_key).await
    }
}

pub fn rename_file(
    connection: &StorageConnection,
    from_key: &str,
    to_key: &str,
) -> Result<(), String> {
    validate_destination(from_key, to_key)?;
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        copy_key(&client, connection, from_key, to_key).await?;
        delete_key(&client, connection, from_key).await
    })
}

pub fn rename_folder(
    connection: &StorageConnection,
    from_prefix: &str,
    to_prefix: &str,
) -> Result<(), String> {
    validate_destination(from_prefix, to_prefix)?;
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        let objects = list_objects(&client, connection, from_prefix).await?;
        for object in &objects {
            let destination = format!("{to_prefix}{}", &object.key[from_prefix.len()..]);
            copy_object(&client, connection, object, &destination).await?;
        }
        delete_keys(
            &client,
            connection,
            objects.into_iter().map(|object| object.key).collect(),
        )
        .await
    })
}

pub fn move_to_trash(
    connection: &StorageConnection,
    key: &str,
    is_folder: bool,
    deleted_at: i64,
) -> Result<(), String> {
    move_to_trash_with_progress(connection, key, is_folder, deleted_at, |_| {})
}

pub fn move_to_trash_with_progress(
    connection: &StorageConnection,
    key: &str,
    is_folder: bool,
    deleted_at: i64,
    mut on_progress: impl FnMut(OperationProgress),
) -> Result<(), String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(move_to_trash_with_client(
        &client,
        connection,
        key,
        is_folder,
        deleted_at,
        &mut on_progress,
    ))
}

async fn move_to_trash_with_client(
    client: &Client,
    connection: &StorageConnection,
    key: &str,
    is_folder: bool,
    deleted_at: i64,
    on_progress: &mut dyn FnMut(OperationProgress),
) -> Result<(), String> {
    if !is_folder {
        let head = client
            .head_object()
            .bucket(&connection.bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| "This file could not be read".to_string())?;
        let size = head
            .content_length()
            .and_then(|size| u64::try_from(size).ok())
            .unwrap_or_default();
        report_progress(on_progress, 0, 1, 0, size);
        let destination = trash_key(deleted_at, key);
        copy_object(
            client,
            connection,
            &ObjectRef {
                key: key.to_string(),
                size,
                modified: None,
            },
            &destination,
        )
        .await?;
        delete_key(client, connection, key).await?;
        report_progress(on_progress, 1, 1, size, size);
        return Ok(());
    }

    client
        .put_object()
        .bucket(&connection.bucket)
        .key(trash_key(deleted_at, key))
        .body(ByteStream::from_static(b""))
        .send()
        .await
        .map_err(|_| "This folder could not be moved to Trash".to_string())?;
    let objects = list_objects(client, connection, key).await?;
    let total_items = objects.len();
    let total_bytes = objects.iter().map(|object| object.size).sum();
    let mut completed_items = 0;
    let mut completed_bytes = 0;
    report_progress(
        on_progress,
        completed_items,
        total_items,
        completed_bytes,
        total_bytes,
    );
    for object in &objects {
        copy_object(
            client,
            connection,
            object,
            &trash_key(deleted_at, &object.key),
        )
        .await?;
        completed_items += 1;
        completed_bytes += object.size;
        report_progress(
            on_progress,
            completed_items,
            total_items,
            completed_bytes,
            total_bytes,
        );
    }
    delete_keys(
        client,
        connection,
        objects.into_iter().map(|object| object.key).collect(),
    )
    .await
}

pub fn list_trash(connection: &StorageConnection) -> Result<Vec<TrashItem>, String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(list_trash_with_client(&client, connection))
}

async fn list_trash_with_client(
    client: &Client,
    connection: &StorageConnection,
) -> Result<Vec<TrashItem>, String> {
    let objects = list_objects(client, connection, TRASH_PREFIX).await?;
    let mut parsed = Vec::new();
    for object in objects {
        if let Some((deleted_at, original_key)) = parse_trash_key(&object.key) {
            parsed.push((deleted_at, original_key, object.size));
        }
    }
    let mut folders = parsed
        .iter()
        .filter(|(_, key, _)| key.ends_with('/'))
        .map(|(deleted_at, key, _)| (*deleted_at, key.clone()))
        .collect::<Vec<_>>();
    folders.sort_by_key(|(_, key)| key.len());

    let mut groups = BTreeMap::<String, TrashItem>::new();
    for (deleted_at, original_key, size) in parsed {
        let grouped_folder = folders.iter().find(|(folder_time, folder_key)| {
            *folder_time == deleted_at && original_key.starts_with(folder_key.as_str())
        });
        let (root_key, is_folder) = grouped_folder
            .map(|(_, key)| (key.clone(), true))
            .unwrap_or_else(|| (original_key.clone(), original_key.ends_with('/')));
        let id = format!("{deleted_at}:{root_key}");
        groups
            .entry(id.clone())
            .and_modify(|item| item.size += size)
            .or_insert_with(|| TrashItem {
                id,
                name: base_name(&root_key),
                original_key: root_key,
                is_folder,
                deleted_at,
                size,
            });
    }
    let mut items = groups.into_values().collect::<Vec<_>>();
    items.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(items)
}

pub fn restore_trash_item(connection: &StorageConnection, item: &TrashItem) -> Result<(), String> {
    restore_trash_item_with_progress(connection, item, |_| {})
}

pub fn restore_trash_item_with_progress(
    connection: &StorageConnection,
    item: &TrashItem,
    mut on_progress: impl FnMut(OperationProgress),
) -> Result<(), String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(restore_trash_item_with_client(
        &client,
        connection,
        item,
        &mut on_progress,
    ))
}

async fn restore_trash_item_with_client(
    client: &Client,
    connection: &StorageConnection,
    item: &TrashItem,
    on_progress: &mut dyn FnMut(OperationProgress),
) -> Result<(), String> {
    if destination_exists(client, connection, item).await? {
        return Err(
            "Something's already there — restore skipped, the trashed copy is untouched.".into(),
        );
    }
    if !item.is_folder {
        report_progress(on_progress, 0, 1, 0, item.size);
        let source = trash_key(item.deleted_at, &item.original_key);
        copy_key(client, connection, &source, &item.original_key).await?;
        delete_key(client, connection, &source).await?;
        report_progress(on_progress, 1, 1, item.size, item.size);
        return Ok(());
    }
    let source_prefix = trash_key(item.deleted_at, &item.original_key);
    let objects = list_objects(client, connection, &source_prefix).await?;
    let total_items = objects.len();
    let total_bytes = objects.iter().map(|object| object.size).sum();
    let mut completed_items = 0;
    let mut completed_bytes = 0;
    report_progress(
        on_progress,
        completed_items,
        total_items,
        completed_bytes,
        total_bytes,
    );
    for object in &objects {
        let destination = format!(
            "{}{}",
            item.original_key,
            &object.key[source_prefix.len()..]
        );
        copy_object(client, connection, object, &destination).await?;
        completed_items += 1;
        completed_bytes += object.size;
        report_progress(
            on_progress,
            completed_items,
            total_items,
            completed_bytes,
            total_bytes,
        );
    }
    delete_keys(
        client,
        connection,
        objects.into_iter().map(|object| object.key).collect(),
    )
    .await
}

pub fn delete_trash_item(connection: &StorageConnection, item: &TrashItem) -> Result<(), String> {
    delete_trash_item_with_progress(connection, item, |_| {})
}

pub fn delete_trash_item_with_progress(
    connection: &StorageConnection,
    item: &TrashItem,
    mut on_progress: impl FnMut(OperationProgress),
) -> Result<(), String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(delete_trash_item_with_client(
        &client,
        connection,
        item,
        &mut on_progress,
    ))
}

async fn delete_trash_item_with_client(
    client: &Client,
    connection: &StorageConnection,
    item: &TrashItem,
    on_progress: &mut dyn FnMut(OperationProgress),
) -> Result<(), String> {
    let key = trash_key(item.deleted_at, &item.original_key);
    if !item.is_folder {
        report_progress(on_progress, 0, 1, 0, item.size);
        delete_key(client, connection, &key).await?;
        report_progress(on_progress, 1, 1, item.size, item.size);
        return Ok(());
    }
    let objects = list_objects(client, connection, &key).await?;
    let total_items = objects.len();
    let total_bytes = objects.iter().map(|object| object.size).sum();
    report_progress(on_progress, 0, total_items, 0, total_bytes);
    let mut completed_items = 0;
    let mut completed_bytes = 0;
    for batch in objects.chunks(1000) {
        delete_keys(
            client,
            connection,
            batch.iter().map(|object| object.key.clone()).collect(),
        )
        .await?;
        completed_items += batch.len();
        completed_bytes += batch.iter().map(|object| object.size).sum::<u64>();
        report_progress(
            on_progress,
            completed_items,
            total_items,
            completed_bytes,
            total_bytes,
        );
    }
    Ok(())
}

pub fn empty_trash(connection: &StorageConnection) -> Result<(), String> {
    empty_trash_with_progress(connection, |_| {})
}

pub fn empty_trash_with_progress(
    connection: &StorageConnection,
    mut on_progress: impl FnMut(OperationProgress),
) -> Result<(), String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        let objects = list_objects(&client, connection, TRASH_PREFIX).await?;
        let total_items = objects.len();
        let total_bytes = objects.iter().map(|object| object.size).sum();
        report_progress(&mut on_progress, 0, total_items, 0, total_bytes);
        let mut completed_items = 0;
        let mut completed_bytes = 0;
        for batch in objects.chunks(1000) {
            delete_keys(
                &client,
                connection,
                batch.iter().map(|object| object.key.clone()).collect(),
            )
            .await?;
            completed_items += batch.len();
            completed_bytes += batch.iter().map(|object| object.size).sum::<u64>();
            report_progress(
                &mut on_progress,
                completed_items,
                total_items,
                completed_bytes,
                total_bytes,
            );
        }
        Ok(())
    })
}

pub fn sweep_expired_trash(
    connection: &StorageConnection,
    now_ms: i64,
) -> Result<TrashSweepStats, String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(sweep_expired_trash_with_client(&client, connection, now_ms))
}

async fn sweep_expired_trash_with_client(
    client: &Client,
    connection: &StorageConnection,
    now_ms: i64,
) -> Result<TrashSweepStats, String> {
    let objects = list_objects(client, connection, TRASH_PREFIX).await?;
    let mut stats = TrashSweepStats {
        scanned: objects.len(),
        ..TrashSweepStats::default()
    };
    let expired = objects
        .into_iter()
        .filter(|object| {
            parse_trash_key(&object.key)
                .is_some_and(|(deleted_at, _)| is_trash_expired(deleted_at, now_ms))
        })
        .map(|object| object.key)
        .collect::<Vec<_>>();
    for batch in expired.chunks(1000) {
        match delete_keys(client, connection, batch.to_vec()).await {
            Ok(()) => stats.purged += batch.len(),
            Err(_) => stats.errors += 1,
        }
    }
    Ok(stats)
}

pub fn share_link(
    connection: &StorageConnection,
    key: &str,
    expires_in_seconds: u64,
) -> Result<String, String> {
    let client = s3::client(connection)?;
    s3::runtime()?.block_on(async {
        let config = PresigningConfig::expires_in(Duration::from_secs(
            expires_in_seconds.min(7 * 24 * 60 * 60),
        ))
        .map_err(|_| "A share link could not be created".to_string())?;
        client
            .get_object()
            .bucket(&connection.bucket)
            .key(key)
            .presigned(config)
            .await
            .map(|request| request.uri().to_string())
            .map_err(|_| "A share link could not be created".to_string())
    })
}

async fn destination_exists(
    client: &Client,
    connection: &StorageConnection,
    item: &TrashItem,
) -> Result<bool, String> {
    if item.is_folder {
        let output = client
            .list_objects_v2()
            .bucket(&connection.bucket)
            .prefix(&item.original_key)
            .max_keys(1)
            .send()
            .await
            .map_err(|_| "This storage could not be checked".to_string())?;
        Ok(output.key_count().unwrap_or_default() > 0)
    } else {
        Ok(client
            .head_object()
            .bucket(&connection.bucket)
            .key(&item.original_key)
            .send()
            .await
            .is_ok())
    }
}

async fn copy_key(
    client: &Client,
    connection: &StorageConnection,
    from_key: &str,
    to_key: &str,
) -> Result<(), String> {
    let head = client
        .head_object()
        .bucket(&connection.bucket)
        .key(from_key)
        .send()
        .await
        .map_err(|_| "This file could not be read".to_string())?;
    let size = head
        .content_length()
        .and_then(|size| u64::try_from(size).ok())
        .unwrap_or_default();
    copy_object(
        client,
        connection,
        &ObjectRef {
            key: from_key.to_string(),
            size,
            modified: None,
        },
        to_key,
    )
    .await
}

async fn copy_object(
    client: &Client,
    connection: &StorageConnection,
    object: &ObjectRef,
    destination: &str,
) -> Result<(), String> {
    let source = copy_source(&connection.bucket, &object.key);
    if object.size < COPY_MULTIPART_THRESHOLD {
        client
            .copy_object()
            .bucket(&connection.bucket)
            .copy_source(source)
            .key(destination)
            .send()
            .await
            .map_err(|_| "This file could not be moved".to_string())?;
        return Ok(());
    }

    let created = client
        .create_multipart_upload()
        .bucket(&connection.bucket)
        .key(destination)
        .send()
        .await
        .map_err(|_| "This file could not be moved".to_string())?;
    let Some(upload_id) = created.upload_id() else {
        return Err("This file could not be moved".into());
    };
    let result = async {
        let mut parts = Vec::new();
        let part_count = object.size.div_ceil(COPY_PART_SIZE) as i32;
        for part_number in 1..=part_count {
            let start = (part_number as u64 - 1) * COPY_PART_SIZE;
            let end = (start + COPY_PART_SIZE).min(object.size) - 1;
            let output = client
                .upload_part_copy()
                .bucket(&connection.bucket)
                .key(destination)
                .upload_id(upload_id)
                .part_number(part_number)
                .copy_source(&source)
                .copy_source_range(format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(|_| "This file could not be moved".to_string())?;
            let etag = output
                .copy_part_result()
                .and_then(|result| result.e_tag())
                .unwrap_or_default();
            parts.push(
                CompletedPart::builder()
                    .part_number(part_number)
                    .e_tag(etag)
                    .build(),
            );
        }
        let completed = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();
        client
            .complete_multipart_upload()
            .bucket(&connection.bucket)
            .key(destination)
            .upload_id(upload_id)
            .multipart_upload(completed)
            .send()
            .await
            .map_err(|_| "This file could not be moved".to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = client
            .abort_multipart_upload()
            .bucket(&connection.bucket)
            .key(destination)
            .upload_id(upload_id)
            .send()
            .await;
    }
    result
}

async fn delete_key(
    client: &Client,
    connection: &StorageConnection,
    key: &str,
) -> Result<(), String> {
    client
        .delete_object()
        .bucket(&connection.bucket)
        .key(key)
        .send()
        .await
        .map_err(|_| "This file could not be removed".to_string())?;
    Ok(())
}

async fn delete_keys(
    client: &Client,
    connection: &StorageConnection,
    keys: Vec<String>,
) -> Result<(), String> {
    for batch in keys.chunks(1000) {
        let objects = batch
            .iter()
            .map(|key| ObjectIdentifier::builder().key(key).build())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "These files could not be removed".to_string())?;
        let delete = Delete::builder()
            .set_objects(Some(objects))
            .build()
            .map_err(|_| "These files could not be removed".to_string())?;
        client
            .delete_objects()
            .bucket(&connection.bucket)
            .delete(delete)
            .send()
            .await
            .map_err(|_| "These files could not be removed".to_string())?;
    }
    Ok(())
}

async fn list_objects(
    client: &Client,
    connection: &StorageConnection,
    prefix: &str,
) -> Result<Vec<ObjectRef>, String> {
    let mut token = None;
    let mut objects = Vec::new();
    loop {
        let output = client
            .list_objects_v2()
            .bucket(&connection.bucket)
            .prefix(prefix)
            .set_continuation_token(token)
            .send()
            .await
            .map_err(|_| "This folder could not be read".to_string())?;
        for object in output.contents() {
            if let Some(key) = object.key() {
                objects.push(ObjectRef {
                    key: key.to_string(),
                    size: object
                        .size()
                        .and_then(|size| u64::try_from(size).ok())
                        .unwrap_or_default(),
                    modified: object.last_modified().map(|date| date.secs() * 1000),
                });
            }
        }
        if output.is_truncated() != Some(true) {
            break;
        }
        token = output.next_continuation_token().map(str::to_string);
    }
    Ok(objects)
}

fn validate_destination(from: &str, to: &str) -> Result<(), String> {
    if to.trim().is_empty() || from == to {
        return Err("Choose a different name".into());
    }
    Ok(())
}

fn trash_key(deleted_at: i64, original_key: &str) -> String {
    format!("{TRASH_PREFIX}{deleted_at}/{original_key}")
}

fn parse_trash_key(key: &str) -> Option<(i64, String)> {
    let remainder = key.strip_prefix(TRASH_PREFIX)?;
    let (timestamp, original_key) = remainder.split_once('/')?;
    if original_key.is_empty() {
        return None;
    }
    Some((timestamp.parse().ok()?, original_key.to_string()))
}

fn is_trash_expired(deleted_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(deleted_at_ms) >= TRASH_RETENTION_MS
}

fn base_name(key: &str) -> String {
    key.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(key)
        .to_string()
}

fn copy_source(bucket: &str, key: &str) -> String {
    let source = format!("/{bucket}/{key}");
    let mut encoded = String::new();
    for byte in source.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'/') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn round_trips_trash_keys() {
        let key = trash_key(123, "folder/file name.txt");
        assert_eq!(
            parse_trash_key(&key),
            Some((123, "folder/file name.txt".into()))
        );
    }

    #[test]
    fn encodes_copy_sources_without_hiding_slashes() {
        assert_eq!(
            copy_source("files", "folder/file name.txt"),
            "/files/folder/file%20name.txt"
        );
    }

    #[test]
    fn expires_trash_at_thirty_days() {
        let now = TRASH_RETENTION_MS + 100;
        assert!(!is_trash_expired(101, now));
        assert!(is_trash_expired(100, now));
        assert!(!is_trash_expired(now + 1, now));
    }

    #[test]
    #[ignore]
    fn moves_real_minio_objects_without_downloading_them() {
        let suffix = Uuid::new_v4().to_string();
        let bucket = format!("lopload-operations-{suffix}");
        let connection = StorageConnection {
            id: format!("integration-{suffix}"),
            name: "Integration test".into(),
            endpoint: "http://127.0.0.1:9400".into(),
            bucket: bucket.clone(),
            region: "us-east-1".into(),
            last_prefix: String::new(),
            created_at: 0,
        };
        let client =
            s3::client_with_credentials(&connection, "minioadmin".into(), "minioadmin".into());
        s3::runtime()
            .expect("runtime")
            .block_on(async {
                client.create_bucket().bucket(&bucket).send().await?;
                client
                    .put_object()
                    .bucket(&bucket)
                    .key("folder/file name.txt")
                    .body(ByteStream::from_static(b"native move"))
                    .send()
                    .await?;
                copy_key(
                    &client,
                    &connection,
                    "folder/file name.txt",
                    "renamed/file name.txt",
                )
                .await?;
                delete_key(&client, &connection, "folder/file name.txt").await?;
                let copied = client
                    .get_object()
                    .bucket(&bucket)
                    .key("renamed/file name.txt")
                    .send()
                    .await?
                    .body
                    .collect()
                    .await?
                    .into_bytes();
                assert_eq!(copied.as_ref(), b"native move");
                move_entry_with_client(
                    &client,
                    &connection,
                    "renamed/file name.txt",
                    false,
                    "moved/file name.txt",
                    &mut |_| {},
                )
                .await?;
                assert!(
                    client
                        .head_object()
                        .bucket(&bucket)
                        .key("renamed/file name.txt")
                        .send()
                        .await
                        .is_err()
                );
                let moved = client
                    .get_object()
                    .bucket(&bucket)
                    .key("moved/file name.txt")
                    .send()
                    .await?
                    .body
                    .collect()
                    .await?
                    .into_bytes();
                assert_eq!(moved.as_ref(), b"native move");
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key("moved/file name.txt")
                    .send()
                    .await?;
                client.delete_bucket().bucket(&bucket).send().await?;
                Ok::<_, Box<dyn std::error::Error>>(())
            })
            .expect("move objects");
    }

    #[test]
    #[ignore]
    fn trashes_restores_and_permanently_deletes_real_minio_folders() {
        let suffix = Uuid::new_v4().to_string();
        let bucket = format!("lopload-trash-{suffix}");
        let connection = StorageConnection {
            id: format!("integration-{suffix}"),
            name: "Integration test".into(),
            endpoint: "http://127.0.0.1:9400".into(),
            bucket: bucket.clone(),
            region: "us-east-1".into(),
            last_prefix: String::new(),
            created_at: 0,
        };
        let client =
            s3::client_with_credentials(&connection, "minioadmin".into(), "minioadmin".into());
        s3::runtime()
            .expect("runtime")
            .block_on(async {
                client.create_bucket().bucket(&bucket).send().await?;
                for (key, body) in [
                    ("folder/alpha.txt", b"alpha".as_slice()),
                    ("folder/nested/beta.txt", b"beta".as_slice()),
                ] {
                    client
                        .put_object()
                        .bucket(&bucket)
                        .key(key)
                        .body(ByteStream::from(body.to_vec()))
                        .send()
                        .await?;
                }

                let mut trash_progress = Vec::new();
                move_to_trash_with_client(
                    &client,
                    &connection,
                    "folder/",
                    true,
                    123_456,
                    &mut |progress| trash_progress.push(progress),
                )
                .await?;
                assert_eq!(
                    trash_progress
                        .first()
                        .map(|progress| progress.completed_items),
                    Some(0)
                );
                assert_eq!(
                    trash_progress
                        .last()
                        .map(|progress| progress.completed_items),
                    Some(2)
                );
                assert!(
                    client
                        .head_object()
                        .bucket(&bucket)
                        .key("folder/alpha.txt")
                        .send()
                        .await
                        .is_err()
                );

                let items = list_trash_with_client(&client, &connection).await?;
                assert_eq!(items.len(), 1);
                assert!(items[0].is_folder);
                assert_eq!(items[0].original_key, "folder/");
                assert_eq!(items[0].size, 9);

                let mut restore_progress = Vec::new();
                restore_trash_item_with_client(&client, &connection, &items[0], &mut |progress| {
                    restore_progress.push(progress)
                })
                .await?;
                assert_eq!(
                    restore_progress
                        .first()
                        .map(|progress| progress.completed_items),
                    Some(0)
                );
                assert_eq!(
                    restore_progress
                        .last()
                        .map(|progress| progress.completed_items),
                    restore_progress.last().map(|progress| progress.total_items)
                );
                let restored = client
                    .get_object()
                    .bucket(&bucket)
                    .key("folder/nested/beta.txt")
                    .send()
                    .await?
                    .body
                    .collect()
                    .await?
                    .into_bytes();
                assert_eq!(restored.as_ref(), b"beta");
                assert!(
                    list_trash_with_client(&client, &connection)
                        .await?
                        .is_empty()
                );

                move_to_trash_with_client(
                    &client,
                    &connection,
                    "folder/",
                    true,
                    234_567,
                    &mut |_| {},
                )
                .await?;
                let item = list_trash_with_client(&client, &connection)
                    .await?
                    .into_iter()
                    .next()
                    .expect("trashed folder");
                let mut delete_progress = Vec::new();
                delete_trash_item_with_client(&client, &connection, &item, &mut |progress| {
                    delete_progress.push(progress)
                })
                .await?;
                assert_eq!(
                    delete_progress
                        .last()
                        .map(|progress| progress.completed_items),
                    delete_progress.last().map(|progress| progress.total_items)
                );
                assert!(list_objects(&client, &connection, "").await?.is_empty());

                let now = TRASH_RETENTION_MS + 1_000;
                for key in [trash_key(999, "expired.txt"), trash_key(now, "fresh.txt")] {
                    client
                        .put_object()
                        .bucket(&bucket)
                        .key(key)
                        .body(ByteStream::from_static(b"trash"))
                        .send()
                        .await?;
                }
                let sweep = sweep_expired_trash_with_client(&client, &connection, now).await?;
                assert_eq!(
                    sweep,
                    TrashSweepStats {
                        scanned: 2,
                        purged: 1,
                        errors: 0
                    }
                );
                assert!(
                    client
                        .head_object()
                        .bucket(&bucket)
                        .key(trash_key(999, "expired.txt"))
                        .send()
                        .await
                        .is_err()
                );
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key(trash_key(now, "fresh.txt"))
                    .send()
                    .await?;
                client.delete_bucket().bucket(&bucket).send().await?;
                Ok::<_, Box<dyn std::error::Error>>(())
            })
            .expect("trash lifecycle");
    }
}
