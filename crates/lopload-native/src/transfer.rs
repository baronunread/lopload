use crate::{StorageConnection, open_database, s3, settings};
use aws_sdk_s3::{
    Client,
    primitives::ByteStream,
    types::{CompletedMultipartUpload, CompletedPart},
};
use md5::{Digest, Md5};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MULTIPART_THRESHOLD: u64 = 16 * 1024 * 1024;
const DEFAULT_PART_SIZE: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum TransferState {
    Queued,
    Sending { percent: f32 },
    Checking,
    Uploaded,
    Downloaded,
    Failed { error_class: ErrorClass },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorClass {
    Offline,
    Credentials,
    StorageFull,
    ConnectionDropped,
    Verification,
    NotFound,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transfer {
    pub id: String,
    pub connection_id: String,
    pub remote_key: String,
    pub local_path: String,
    pub size: u64,
    pub part_size: u64,
    pub upload_id: Option<String>,
    pub direction: TransferDirection,
    pub state: TransferState,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
struct TransferPart {
    transfer_id: String,
    part_number: i32,
    etag: String,
    size: u64,
}

#[derive(Clone, Default)]
pub struct TransferControl(Arc<AtomicBool>);

impl TransferControl {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub fn upload_file(
    connection: &StorageConnection,
    local_path: &Path,
    remote_key: &str,
    control: &TransferControl,
    on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let client = s3::client(connection)?;
    upload_file_with_client(
        &client, connection, local_path, remote_key, control, on_update,
    )
}

pub fn resume_upload(
    connection: &StorageConnection,
    transfer: Transfer,
    control: &TransferControl,
    on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let client = s3::client(connection)?;
    resume_upload_with_client(&client, connection, transfer, control, on_update)
}

fn resume_upload_with_client(
    client: &Client,
    connection: &StorageConnection,
    mut transfer: Transfer,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    if !matches!(transfer.direction, TransferDirection::Upload)
        || transfer.upload_id.is_none()
        || !matches!(
            transfer.state,
            TransferState::Queued
                | TransferState::Sending { .. }
                | TransferState::Checking
                | TransferState::Failed { .. }
        )
    {
        return Err("This transfer cannot be resumed".into());
    }
    transfer.state = TransferState::Queued;
    transfer.updated_at = now()?;
    persist(&transfer)?;
    emit(&transfer, &mut on_update);
    transition(
        &mut transfer,
        TransferState::Sending { percent: 0.0 },
        &mut on_update,
    )?;
    upload_multipart(client, connection, transfer, control, on_update)
}

fn upload_file_with_client(
    client: &Client,
    connection: &StorageConnection,
    local_path: &Path,
    remote_key: &str,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let size = fs::metadata(local_path)
        .map_err(|_| "This local file could not be read".to_string())?
        .len();
    let mut transfer = new_transfer(
        connection,
        local_path,
        remote_key,
        size,
        TransferDirection::Upload,
    )?;
    emit(&transfer, &mut on_update);
    transition(
        &mut transfer,
        TransferState::Sending { percent: 0.0 },
        &mut on_update,
    )?;
    if size >= MULTIPART_THRESHOLD || transfer.upload_id.is_some() {
        return upload_multipart(client, connection, transfer, control, on_update);
    }
    let body = match fs::read(local_path) {
        Ok(body) => body,
        Err(_) => return fail(transfer, ErrorClass::NotFound, &mut on_update),
    };
    let local_md5 = hex_digest(&body);
    transition(
        &mut transfer,
        TransferState::Sending { percent: 50.0 },
        &mut on_update,
    )?;
    ensure_not_cancelled(&transfer, control)?;

    let result = s3::runtime()?.block_on(async {
        client
            .put_object()
            .bucket(&connection.bucket)
            .key(remote_key)
            .body(ByteStream::from(body))
            .send()
            .await
    });
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            return fail(transfer, classify_error(&error.to_string()), &mut on_update);
        }
    };
    ensure_not_cancelled(&transfer, control)?;
    transition(&mut transfer, TransferState::Checking, &mut on_update)?;
    let remote_etag = output.e_tag().unwrap_or_default().trim_matches('"');
    if !remote_etag.eq_ignore_ascii_case(&local_md5) {
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    }
    transition(&mut transfer, TransferState::Uploaded, &mut on_update)?;
    Ok(transfer)
}

fn upload_multipart(
    client: &Client,
    connection: &StorageConnection,
    mut transfer: Transfer,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let upload_id = if let Some(upload_id) = transfer.upload_id.clone() {
        upload_id
    } else {
        ensure_not_cancelled(&transfer, control)?;
        let created = s3::runtime()?.block_on(
            client
                .create_multipart_upload()
                .bucket(&connection.bucket)
                .key(&transfer.remote_key)
                .send(),
        );
        let created = match created {
            Ok(created) => created,
            Err(error) => {
                return fail(transfer, classify_error(&error.to_string()), &mut on_update);
            }
        };
        let Some(upload_id) = created.upload_id().map(str::to_string) else {
            return fail(transfer, ErrorClass::Unknown, &mut on_update);
        };
        transfer.upload_id = Some(upload_id.clone());
        persist(&transfer)?;
        upload_id
    };

    let mut completed = list_remote_parts(client, connection, &transfer, &upload_id)
        .unwrap_or_else(|_| list_parts(&transfer.id).unwrap_or_default());
    completed.retain(|part| {
        part.size == part_length(transfer.size, transfer.part_size, part.part_number)
    });
    let total_size = transfer.size;
    let total_parts = transfer.size.div_ceil(transfer.part_size) as i32;
    let mut bytes_done = completed.iter().map(|part| part.size).sum::<u64>();
    transition(
        &mut transfer,
        TransferState::Sending {
            percent: percent(bytes_done, total_size),
        },
        &mut on_update,
    )?;

    let pending = (1..=total_parts)
        .filter(|part_number| {
            !completed
                .iter()
                .any(|part| part.part_number == *part_number)
        })
        .collect::<Vec<_>>();
    let concurrency = settings::transfer_tuning()
        .map(|tuning| tuning.upload_parts_in_flight.max(1) as usize)
        .unwrap_or(1);
    for group in pending.chunks(concurrency) {
        ensure_multipart_not_cancelled(client, connection, &transfer, &upload_id, control)?;
        let results = s3::runtime()?.block_on(async {
            let mut tasks = tokio::task::JoinSet::new();
            for part_number in group.iter().copied() {
                let client = client.clone();
                let bucket = connection.bucket.clone();
                let key = transfer.remote_key.clone();
                let upload_id = upload_id.clone();
                let local_path = transfer.local_path.clone();
                let transfer_id = transfer.id.clone();
                let part_size = transfer.part_size;
                let total_size = transfer.size;
                tasks.spawn(async move {
                    let length = part_length(total_size, part_size, part_number);
                    let offset = (part_number as u64 - 1) * part_size;
                    let body = read_file_range(Path::new(&local_path), offset, length)?;
                    let output = client
                        .upload_part()
                        .bucket(bucket)
                        .key(key)
                        .upload_id(upload_id)
                        .part_number(part_number)
                        .body(ByteStream::from(body))
                        .send()
                        .await
                        .map_err(|error| error.to_string())?;
                    Ok::<_, String>(TransferPart {
                        transfer_id,
                        part_number,
                        etag: output.e_tag().unwrap_or_default().to_string(),
                        size: length,
                    })
                });
            }
            let mut results = Vec::new();
            while let Some(result) = tasks.join_next().await {
                results.push(result.map_err(|error| error.to_string())??);
            }
            Ok::<_, String>(results)
        });
        let results = match results {
            Ok(results) => results,
            Err(error) => return fail(transfer, classify_error(&error), &mut on_update),
        };
        ensure_multipart_not_cancelled(client, connection, &transfer, &upload_id, control)?;
        for result in results {
            save_part(&result)?;
            bytes_done += result.size;
            completed.push(result);
            transition(
                &mut transfer,
                TransferState::Sending {
                    percent: percent(bytes_done, total_size),
                },
                &mut on_update,
            )?;
        }
    }

    completed.sort_by_key(|part| part.part_number);
    ensure_multipart_not_cancelled(client, connection, &transfer, &upload_id, control)?;
    let parts = completed
        .iter()
        .map(|part| {
            CompletedPart::builder()
                .part_number(part.part_number)
                .e_tag(&part.etag)
                .build()
        })
        .collect::<Vec<_>>();
    let completed_upload = CompletedMultipartUpload::builder()
        .set_parts(Some(parts))
        .build();
    let result = s3::runtime()?.block_on(
        client
            .complete_multipart_upload()
            .bucket(&connection.bucket)
            .key(&transfer.remote_key)
            .upload_id(&upload_id)
            .multipart_upload(completed_upload)
            .send(),
    );
    if let Err(error) = result {
        return fail(transfer, classify_error(&error.to_string()), &mut on_update);
    }
    transfer.upload_id = None;
    persist(&transfer)?;
    transition(&mut transfer, TransferState::Checking, &mut on_update)?;

    let head = s3::runtime()?.block_on(
        client
            .head_object()
            .bucket(&connection.bucket)
            .key(&transfer.remote_key)
            .send(),
    );
    let head = match head {
        Ok(head) => head,
        Err(error) => {
            return fail(transfer, classify_error(&error.to_string()), &mut on_update);
        }
    };
    let actual_size = head
        .content_length()
        .and_then(|size| u64::try_from(size).ok());
    let actual_etag = head.e_tag().unwrap_or_default().trim_matches('"');
    let expected_etag = composite_etag(&completed);
    if actual_size != Some(transfer.size)
        || !expected_etag
            .as_deref()
            .is_some_and(|expected| expected.eq_ignore_ascii_case(actual_etag))
    {
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    }
    transition(&mut transfer, TransferState::Uploaded, &mut on_update)?;
    Ok(transfer)
}

pub fn download_file(
    connection: &StorageConnection,
    remote_key: &str,
    destination: &Path,
    expected_size: u64,
    control: &TransferControl,
    on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let client = s3::client(connection)?;
    download_file_with_client(
        &client,
        connection,
        remote_key,
        destination,
        expected_size,
        control,
        on_update,
    )
}

fn download_file_with_client(
    client: &Client,
    connection: &StorageConnection,
    remote_key: &str,
    destination: &Path,
    expected_size: u64,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let mut transfer = new_transfer(
        connection,
        destination,
        remote_key,
        expected_size,
        TransferDirection::Download,
    )?;
    emit(&transfer, &mut on_update);
    transition(
        &mut transfer,
        TransferState::Sending { percent: 0.0 },
        &mut on_update,
    )?;
    if expected_size >= MULTIPART_THRESHOLD {
        return download_ranged(client, connection, transfer, control, on_update);
    }
    download_streamed(client, connection, transfer, control, on_update)
}

pub fn resume_download(
    connection: &StorageConnection,
    transfer: Transfer,
    control: &TransferControl,
    on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let client = s3::client(connection)?;
    resume_download_with_client(&client, connection, transfer, control, on_update)
}

fn resume_download_with_client(
    client: &Client,
    connection: &StorageConnection,
    mut transfer: Transfer,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    if !matches!(transfer.direction, TransferDirection::Download)
        || !matches!(transfer.state, TransferState::Failed { .. })
    {
        return Err("This transfer cannot be retried".into());
    }
    transfer.state = TransferState::Queued;
    transfer.updated_at = now()?;
    persist(&transfer)?;
    emit(&transfer, &mut on_update);
    transition(
        &mut transfer,
        TransferState::Sending { percent: 0.0 },
        &mut on_update,
    )?;
    if transfer.size >= MULTIPART_THRESHOLD {
        download_ranged(client, connection, transfer, control, on_update)
    } else {
        download_streamed(client, connection, transfer, control, on_update)
    }
}

fn download_streamed(
    client: &Client,
    connection: &StorageConnection,
    mut transfer: Transfer,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let remote_key = transfer.remote_key.clone();
    let expected_size = transfer.size;
    let destination = PathBuf::from(&transfer.local_path);
    let result = s3::runtime()?.block_on(async {
        let output = client
            .get_object()
            .bucket(&connection.bucket)
            .key(&remote_key)
            .send()
            .await?;
        let etag = output
            .e_tag()
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let content_length = output
            .content_length()
            .and_then(|size| u64::try_from(size).ok());
        let bytes = output.body.collect().await?.into_bytes();
        Ok::<_, Box<dyn std::error::Error>>((etag, content_length, bytes))
    });
    let (etag, content_length, bytes) = match result {
        Ok(result) => result,
        Err(error) => {
            return fail(transfer, classify_error(&error.to_string()), &mut on_update);
        }
    };
    ensure_not_cancelled(&transfer, control)?;
    transition(
        &mut transfer,
        TransferState::Sending { percent: 100.0 },
        &mut on_update,
    )?;
    transition(&mut transfer, TransferState::Checking, &mut on_update)?;
    if content_length != Some(bytes.len() as u64)
        || (expected_size > 0 && expected_size != bytes.len() as u64)
        || (is_plain_md5(&etag) && !etag.eq_ignore_ascii_case(&hex_digest(&bytes)))
    {
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    }

    let temporary = temporary_path(&destination);
    if let Some(parent) = destination.parent() {
        if fs::create_dir_all(parent).is_err() {
            return fail(transfer, ErrorClass::StorageFull, &mut on_update);
        }
    }
    if fs::write(&temporary, &bytes).is_err() {
        return fail(transfer, ErrorClass::StorageFull, &mut on_update);
    }
    if replace_file(&temporary, &destination).is_err() {
        let _ = fs::remove_file(&temporary);
        return fail(transfer, ErrorClass::Unknown, &mut on_update);
    }
    transition(&mut transfer, TransferState::Downloaded, &mut on_update)?;
    Ok(transfer)
}

fn download_ranged(
    client: &Client,
    connection: &StorageConnection,
    mut transfer: Transfer,
    control: &TransferControl,
    mut on_update: impl FnMut(Transfer),
) -> Result<Transfer, String> {
    let head = s3::runtime()?.block_on(
        client
            .head_object()
            .bucket(&connection.bucket)
            .key(&transfer.remote_key)
            .send(),
    );
    let head = match head {
        Ok(head) => head,
        Err(error) => {
            return fail(transfer, classify_error(&error.to_string()), &mut on_update);
        }
    };
    let Some(total_size) = head
        .content_length()
        .and_then(|size| u64::try_from(size).ok())
    else {
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    };
    if transfer.size > 0 && transfer.size != total_size {
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    }
    transfer.size = total_size;
    let etag = head
        .e_tag()
        .unwrap_or_default()
        .trim_matches('"')
        .to_string();
    let temporary = temporary_path(Path::new(&transfer.local_path));
    if let Some(parent) = temporary.parent() {
        if fs::create_dir_all(parent).is_err() {
            return fail(transfer, ErrorClass::StorageFull, &mut on_update);
        }
    }

    let mut completed = if fs::metadata(&temporary).map(|meta| meta.len()).ok() == Some(total_size)
    {
        list_parts(&transfer.id).unwrap_or_default()
    } else {
        clear_parts(&transfer.id)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary);
        let Ok(file) = file else {
            return fail(transfer, ErrorClass::StorageFull, &mut on_update);
        };
        if file.set_len(total_size).is_err() {
            return fail(transfer, ErrorClass::StorageFull, &mut on_update);
        }
        Vec::new()
    };
    completed
        .retain(|part| part.size == part_length(total_size, transfer.part_size, part.part_number));
    let total_parts = total_size.div_ceil(transfer.part_size) as i32;
    let mut bytes_done = completed.iter().map(|part| part.size).sum::<u64>();
    transition(
        &mut transfer,
        TransferState::Sending {
            percent: percent(bytes_done, total_size),
        },
        &mut on_update,
    )?;

    let mut file = match OpenOptions::new().write(true).open(&temporary) {
        Ok(file) => file,
        Err(_) => return fail(transfer, ErrorClass::StorageFull, &mut on_update),
    };
    let pending = (1..=total_parts)
        .filter(|part_number| {
            !completed
                .iter()
                .any(|part| part.part_number == *part_number)
        })
        .collect::<Vec<_>>();
    let concurrency = settings::transfer_tuning()
        .map(|tuning| tuning.download_connections.max(1) as usize)
        .unwrap_or(1);
    for group in pending.chunks(concurrency) {
        if control.is_cancelled() {
            let _ = fs::remove_file(&temporary);
            dismiss_transfer(&transfer.id)?;
            return Err("Transfer cancelled".into());
        }
        let results = s3::runtime()?.block_on(async {
            let mut tasks = tokio::task::JoinSet::new();
            for part_number in group.iter().copied() {
                let client = client.clone();
                let bucket = connection.bucket.clone();
                let key = transfer.remote_key.clone();
                let part_size = transfer.part_size;
                tasks.spawn(async move {
                    let length = part_length(total_size, part_size, part_number);
                    let start = (part_number as u64 - 1) * part_size;
                    let end = start + length - 1;
                    let output = client
                        .get_object()
                        .bucket(bucket)
                        .key(key)
                        .range(format!("bytes={start}-{end}"))
                        .send()
                        .await
                        .map_err(|error| error.to_string())?;
                    let bytes = output
                        .body
                        .collect()
                        .await
                        .map_err(|error| error.to_string())?
                        .into_bytes();
                    if bytes.len() as u64 != length {
                        return Err("Downloaded bytes could not be verified".to_string());
                    }
                    Ok::<_, String>((part_number, start, length, bytes))
                });
            }
            let mut results = Vec::new();
            while let Some(result) = tasks.join_next().await {
                results.push(result.map_err(|error| error.to_string())??);
            }
            Ok::<_, String>(results)
        });
        let results = match results {
            Ok(results) => results,
            Err(error) => {
                return fail(transfer, classify_error(&error), &mut on_update);
            }
        };
        if control.is_cancelled() {
            let _ = fs::remove_file(&temporary);
            dismiss_transfer(&transfer.id)?;
            return Err("Transfer cancelled".into());
        }
        for (part_number, start, length, bytes) in results {
            if file.seek(SeekFrom::Start(start)).is_err() || file.write_all(&bytes).is_err() {
                return fail(transfer, ErrorClass::StorageFull, &mut on_update);
            }
            let part = TransferPart {
                transfer_id: transfer.id.clone(),
                part_number,
                etag: String::new(),
                size: length,
            };
            save_part(&part)?;
            completed.push(part);
            bytes_done += length;
            transition(
                &mut transfer,
                TransferState::Sending {
                    percent: percent(bytes_done, total_size),
                },
                &mut on_update,
            )?;
        }
    }
    if file.sync_all().is_err() {
        return fail(transfer, ErrorClass::StorageFull, &mut on_update);
    }
    drop(file);
    transition(&mut transfer, TransferState::Checking, &mut on_update)?;
    let local_md5 = is_plain_md5(&etag)
        .then(|| hex_digest_file(&temporary))
        .flatten();
    if fs::metadata(&temporary).map(|meta| meta.len()).ok() != Some(total_size)
        || (is_plain_md5(&etag) && local_md5.as_deref() != Some(etag.to_lowercase().as_str()))
    {
        let _ = fs::remove_file(&temporary);
        clear_parts(&transfer.id)?;
        return fail(transfer, ErrorClass::Verification, &mut on_update);
    }
    if replace_file(&temporary, Path::new(&transfer.local_path)).is_err() {
        return fail(transfer, ErrorClass::Unknown, &mut on_update);
    }
    transition(&mut transfer, TransferState::Downloaded, &mut on_update)?;
    Ok(transfer)
}

pub fn list_transfers(connection_id: &str) -> Result<Vec<Transfer>, String> {
    let database = open_database()?;
    let mut statement = database
        .prepare(
            "SELECT id, connection_id, remote_key, local_path, size, part_size, upload_id,
                    direction, state, error_class, created_at, updated_at
             FROM transfers WHERE connection_id = ?1 ORDER BY created_at",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([connection_id], row_to_transfer)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn dismiss_transfer(transfer_id: &str) -> Result<(), String> {
    let mut database = open_database()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM transfer_parts WHERE transfer_id = ?1",
            [transfer_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM transfers WHERE id = ?1", [transfer_id])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

fn new_transfer(
    connection: &StorageConnection,
    local_path: &Path,
    remote_key: &str,
    size: u64,
    direction: TransferDirection,
) -> Result<Transfer, String> {
    let now = now()?;
    let transfer = Transfer {
        id: Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        remote_key: remote_key.to_string(),
        local_path: local_path.to_string_lossy().to_string(),
        size,
        part_size: settings::transfer_tuning()
            .map(|tuning| u64::from(tuning.part_size_mib) * 1024 * 1024)
            .unwrap_or(DEFAULT_PART_SIZE),
        upload_id: None,
        direction,
        state: TransferState::Queued,
        created_at: now,
        updated_at: now,
    };
    persist(&transfer)?;
    Ok(transfer)
}

fn transition(
    transfer: &mut Transfer,
    state: TransferState,
    on_update: &mut impl FnMut(Transfer),
) -> Result<(), String> {
    if !valid_transition(&transfer.state, &state) {
        return Err("Invalid transfer state transition".into());
    }
    transfer.state = state;
    transfer.updated_at = now()?;
    persist(transfer)?;
    emit(transfer, on_update);
    Ok(())
}

fn fail<T>(
    mut transfer: Transfer,
    error_class: ErrorClass,
    on_update: &mut impl FnMut(Transfer),
) -> Result<T, String> {
    transfer.state = TransferState::Failed { error_class };
    transfer.updated_at = now()?;
    persist(&transfer)?;
    emit(&transfer, on_update);
    Err("Transfer failed".into())
}

fn ensure_not_cancelled(transfer: &Transfer, control: &TransferControl) -> Result<(), String> {
    if !control.is_cancelled() {
        return Ok(());
    }
    dismiss_transfer(&transfer.id)?;
    Err("Transfer cancelled".into())
}

fn ensure_multipart_not_cancelled(
    client: &Client,
    connection: &StorageConnection,
    transfer: &Transfer,
    upload_id: &str,
    control: &TransferControl,
) -> Result<(), String> {
    if !control.is_cancelled() {
        return Ok(());
    }
    let _ = s3::runtime()?.block_on(
        client
            .abort_multipart_upload()
            .bucket(&connection.bucket)
            .key(&transfer.remote_key)
            .upload_id(upload_id)
            .send(),
    );
    dismiss_transfer(&transfer.id)?;
    Err("Transfer cancelled".into())
}

fn emit(transfer: &Transfer, on_update: &mut impl FnMut(Transfer)) {
    on_update(transfer.clone());
}

fn persist(transfer: &Transfer) -> Result<(), String> {
    let (state, error_class) = state_columns(&transfer.state);
    open_database()?
        .execute(
            "INSERT INTO transfers
             (id, connection_id, remote_key, local_path, size, part_size, upload_id,
              direction, state, error_class, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET state = excluded.state,
               upload_id = excluded.upload_id, error_class = excluded.error_class,
               updated_at = excluded.updated_at",
            params![
                transfer.id,
                transfer.connection_id,
                transfer.remote_key,
                transfer.local_path,
                transfer.size as i64,
                transfer.part_size as i64,
                transfer.upload_id,
                direction_column(&transfer.direction),
                state,
                error_class,
                transfer.created_at,
                transfer.updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn row_to_transfer(row: &rusqlite::Row<'_>) -> rusqlite::Result<Transfer> {
    let state: String = row.get(8)?;
    let error_class: Option<String> = row.get(9)?;
    Ok(Transfer {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        remote_key: row.get(2)?,
        local_path: row.get(3)?,
        size: u64::try_from(row.get::<_, i64>(4)?).unwrap_or_default(),
        part_size: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(DEFAULT_PART_SIZE),
        upload_id: row.get(6)?,
        direction: if row.get::<_, String>(7)? == "download" {
            TransferDirection::Download
        } else {
            TransferDirection::Upload
        },
        state: parse_state(&state, error_class.as_deref()),
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn list_remote_parts(
    client: &Client,
    connection: &StorageConnection,
    transfer: &Transfer,
    upload_id: &str,
) -> Result<Vec<TransferPart>, String> {
    let mut marker = None;
    let mut parts = Vec::new();
    loop {
        let output = s3::runtime()?
            .block_on(
                client
                    .list_parts()
                    .bucket(&connection.bucket)
                    .key(&transfer.remote_key)
                    .upload_id(upload_id)
                    .set_part_number_marker(marker)
                    .send(),
            )
            .map_err(|error| error.to_string())?;
        for part in output.parts() {
            let (Some(part_number), Some(size), Some(etag)) =
                (part.part_number(), part.size(), part.e_tag())
            else {
                continue;
            };
            let Ok(size) = u64::try_from(size) else {
                continue;
            };
            let saved = TransferPart {
                transfer_id: transfer.id.clone(),
                part_number,
                etag: etag.to_string(),
                size,
            };
            save_part(&saved)?;
            parts.push(saved);
        }
        if output.is_truncated() != Some(true) {
            break;
        }
        marker = output.next_part_number_marker().map(str::to_string);
    }
    Ok(parts)
}

fn save_part(part: &TransferPart) -> Result<(), String> {
    open_database()?
        .execute(
            "INSERT INTO transfer_parts (transfer_id, part_number, etag, size)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(transfer_id, part_number) DO UPDATE SET
               etag = excluded.etag, size = excluded.size",
            params![
                part.transfer_id,
                part.part_number,
                part.etag,
                part.size as i64
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn list_parts(transfer_id: &str) -> Result<Vec<TransferPart>, String> {
    let database = open_database()?;
    let mut statement = database
        .prepare(
            "SELECT transfer_id, part_number, etag, size FROM transfer_parts
             WHERE transfer_id = ?1 ORDER BY part_number",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([transfer_id], |row| {
            Ok(TransferPart {
                transfer_id: row.get(0)?,
                part_number: row.get(1)?,
                etag: row.get(2)?,
                size: u64::try_from(row.get::<_, i64>(3)?).unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn clear_parts(transfer_id: &str) -> Result<(), String> {
    open_database()?
        .execute(
            "DELETE FROM transfer_parts WHERE transfer_id = ?1",
            [transfer_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn part_length(total: u64, part_size: u64, part_number: i32) -> u64 {
    let offset = (part_number as u64 - 1) * part_size;
    part_size.min(total.saturating_sub(offset))
}

fn percent(done: u64, total: u64) -> f32 {
    if total == 0 {
        100.0
    } else {
        (done as f64 * 100.0 / total as f64) as f32
    }
}

fn composite_etag(parts: &[TransferPart]) -> Option<String> {
    let mut concatenated = Vec::with_capacity(parts.len() * 16);
    for part in parts {
        let etag = part.etag.trim_matches('"');
        if etag.len() != 32 {
            return None;
        }
        for pair in etag.as_bytes().chunks_exact(2) {
            let pair = std::str::from_utf8(pair).ok()?;
            concatenated.push(u8::from_str_radix(pair, 16).ok()?);
        }
    }
    Some(format!("{}-{}", hex_digest(&concatenated), parts.len()))
}

fn valid_transition(from: &TransferState, to: &TransferState) -> bool {
    matches!(
        (from, to),
        (TransferState::Queued, TransferState::Sending { .. })
            | (TransferState::Sending { .. }, TransferState::Sending { .. })
            | (TransferState::Sending { .. }, TransferState::Checking)
            | (TransferState::Checking, TransferState::Uploaded)
            | (TransferState::Checking, TransferState::Downloaded)
    )
}

fn state_columns(state: &TransferState) -> (&'static str, Option<&'static str>) {
    match state {
        TransferState::Queued => ("queued", None),
        TransferState::Sending { .. } => ("sending", None),
        TransferState::Checking => ("checking", None),
        TransferState::Uploaded => ("uploaded", None),
        TransferState::Downloaded => ("downloaded", None),
        TransferState::Failed { error_class } => ("failed", Some(error_column(error_class))),
    }
}

fn parse_state(state: &str, error_class: Option<&str>) -> TransferState {
    match state {
        "sending" => TransferState::Sending { percent: 0.0 },
        "checking" => TransferState::Checking,
        "uploaded" => TransferState::Uploaded,
        "downloaded" => TransferState::Downloaded,
        "failed" => TransferState::Failed {
            error_class: parse_error_class(error_class),
        },
        _ => TransferState::Queued,
    }
}

fn direction_column(direction: &TransferDirection) -> &'static str {
    match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    }
}

fn error_column(error: &ErrorClass) -> &'static str {
    match error {
        ErrorClass::Offline => "offline",
        ErrorClass::Credentials => "credentials",
        ErrorClass::StorageFull => "storage-full",
        ErrorClass::ConnectionDropped => "connection-dropped",
        ErrorClass::Verification => "verification",
        ErrorClass::NotFound => "not-found",
        ErrorClass::Unknown => "unknown",
    }
}

fn parse_error_class(error: Option<&str>) -> ErrorClass {
    match error {
        Some("offline") => ErrorClass::Offline,
        Some("credentials") => ErrorClass::Credentials,
        Some("storage-full") => ErrorClass::StorageFull,
        Some("connection-dropped") => ErrorClass::ConnectionDropped,
        Some("verification") => ErrorClass::Verification,
        Some("not-found") => ErrorClass::NotFound,
        _ => ErrorClass::Unknown,
    }
}

fn classify_error(error: &str) -> ErrorClass {
    let lower = error.to_lowercase();
    if lower.contains("credential") || lower.contains("accessdenied") || lower.contains("403") {
        ErrorClass::Credentials
    } else if lower.contains("notfound") || lower.contains("nosuchkey") || lower.contains("404") {
        ErrorClass::NotFound
    } else if lower.contains("connect") || lower.contains("dns") || lower.contains("offline") {
        ErrorClass::Offline
    } else if lower.contains("timeout") || lower.contains("reset") || lower.contains("broken pipe")
    {
        ErrorClass::ConnectionDropped
    } else {
        ErrorClass::Unknown
    }
}

fn is_plain_md5(etag: &str) -> bool {
    etag.len() == 32 && etag.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}

fn hex_digest_file(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Md5::new();
    let mut buffer = vec![0; 4 * 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn read_file_range(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|_| "This local file could not be read")?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "This local file could not be read")?;
    let mut body = vec![0; length as usize];
    file.read_exact(&mut body)
        .map_err(|_| "This local file could not be read")?;
    Ok(body)
}

fn replace_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    match fs::rename(temporary, destination) {
        Ok(()) => Ok(()),
        Err(error) if destination.exists() => {
            fs::remove_file(destination)?;
            fs::rename(temporary, destination).map_err(|_| error)
        }
        Err(error) => Err(error),
    }
}

fn temporary_path(destination: &Path) -> PathBuf {
    let mut name = destination
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".lopload-part");
    destination.with_file_name(name)
}

fn now() -> Result<i64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Could not read the system clock".to_string())?
        .as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn enforces_transfer_state_machine() {
        assert!(valid_transition(
            &TransferState::Queued,
            &TransferState::Sending { percent: 0.0 }
        ));
        assert!(!valid_transition(
            &TransferState::Queued,
            &TransferState::Uploaded
        ));
    }

    #[test]
    fn recognizes_plain_md5_etags() {
        assert!(is_plain_md5("5d41402abc4b2a76b9719d911017c592"));
        assert!(!is_plain_md5("abc-2"));
    }

    #[test]
    #[ignore]
    fn uploads_and_downloads_real_minio_bytes() {
        let suffix = Uuid::new_v4().to_string();
        let bucket = format!("lopload-transfer-{suffix}");
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
            .block_on(client.create_bucket().bucket(&bucket).send())
            .expect("create bucket");

        let source = std::env::temp_dir().join(format!("lopload-source-{suffix}.bin"));
        let destination = std::env::temp_dir().join(format!("lopload-download-{suffix}.bin"));
        let resumed_destination =
            std::env::temp_dir().join(format!("lopload-resumed-download-{suffix}.bin"));
        let payload = (0..=255)
            .cycle()
            .take(MULTIPART_THRESHOLD as usize + 1024)
            .collect::<Vec<_>>();
        fs::write(&source, &payload).expect("write source");
        let mut events = Vec::new();
        let uploaded = upload_file_with_client(
            &client,
            &connection,
            &source,
            "round-trip.bin",
            &TransferControl::default(),
            |transfer| events.push(transfer),
        );
        let created = s3::runtime()
            .expect("runtime")
            .block_on(
                client
                    .create_multipart_upload()
                    .bucket(&bucket)
                    .key("resumed.bin")
                    .send(),
            )
            .expect("create resumable upload");
        let upload_id = created.upload_id().expect("upload id").to_string();
        s3::runtime()
            .expect("runtime")
            .block_on(
                client
                    .upload_part()
                    .bucket(&bucket)
                    .key("resumed.bin")
                    .upload_id(&upload_id)
                    .part_number(1)
                    .body(ByteStream::from(
                        payload[..DEFAULT_PART_SIZE as usize].to_vec(),
                    ))
                    .send(),
            )
            .expect("first resumable part");
        let mut interrupted = new_transfer(
            &connection,
            &source,
            "resumed.bin",
            payload.len() as u64,
            TransferDirection::Upload,
        )
        .expect("persist interrupted transfer");
        interrupted.upload_id = Some(upload_id);
        interrupted.state = TransferState::Sending { percent: 20.0 };
        persist(&interrupted).expect("persist upload id");
        let resumed = resume_upload_with_client(
            &client,
            &connection,
            interrupted,
            &TransferControl::default(),
            |transfer| events.push(transfer),
        );
        let downloaded = download_file_with_client(
            &client,
            &connection,
            "round-trip.bin",
            &destination,
            payload.len() as u64,
            &TransferControl::default(),
            |transfer| events.push(transfer),
        );
        let mut interrupted_download = new_transfer(
            &connection,
            &resumed_destination,
            "round-trip.bin",
            payload.len() as u64,
            TransferDirection::Download,
        )
        .expect("persist interrupted download");
        interrupted_download.state = TransferState::Failed {
            error_class: ErrorClass::ConnectionDropped,
        };
        persist(&interrupted_download).expect("persist failed download");
        let resumed_temporary = temporary_path(&resumed_destination);
        let mut partial = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&resumed_temporary)
            .expect("create partial download");
        partial
            .set_len(payload.len() as u64)
            .expect("allocate partial download");
        partial
            .write_all(&payload[..DEFAULT_PART_SIZE as usize])
            .expect("write first range");
        drop(partial);
        save_part(&TransferPart {
            transfer_id: interrupted_download.id.clone(),
            part_number: 1,
            etag: String::new(),
            size: DEFAULT_PART_SIZE,
        })
        .expect("persist first range");
        let resumed_download = resume_download_with_client(
            &client,
            &connection,
            interrupted_download,
            &TransferControl::default(),
            |transfer| events.push(transfer),
        );

        s3::runtime()
            .expect("runtime")
            .block_on(async {
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key("round-trip.bin")
                    .send()
                    .await?;
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key("resumed.bin")
                    .send()
                    .await?;
                client.delete_bucket().bucket(&bucket).send().await?;
                Ok::<_, Box<dyn std::error::Error>>(())
            })
            .expect("clean bucket");
        for transfer in &events {
            let _ = dismiss_transfer(&transfer.id);
        }
        let _ = fs::remove_file(&source);

        assert!(matches!(
            uploaded.expect("upload").state,
            TransferState::Uploaded
        ));
        assert!(matches!(
            downloaded.expect("download").state,
            TransferState::Downloaded
        ));
        assert!(matches!(
            resumed.expect("resumed upload").state,
            TransferState::Uploaded
        ));
        assert!(matches!(
            resumed_download.expect("resumed download").state,
            TransferState::Downloaded
        ));
        assert_eq!(fs::read(&destination).expect("downloaded bytes"), payload);
        assert_eq!(
            fs::read(&resumed_destination).expect("resumed downloaded bytes"),
            payload
        );
        fs::remove_file(destination).expect("remove download");
        fs::remove_file(resumed_destination).expect("remove resumed download");
    }
}
