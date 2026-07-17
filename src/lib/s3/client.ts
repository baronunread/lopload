// Factory for S3Client + browse/rename/delete/createFolder/copyLink/testConnection
// helpers. All S3 access in this app goes through a client built here so the
// fetch implementation (and therefore the CORS bypass) stays dependency-injected.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Connection, Credentials, PlainError, RemoteEntry } from "../types";
import { toPlainError } from "../errors";
import { createLogger } from "../logger";
import { mapWithConcurrency } from "../concurrency";
import { InjectedFetchHttpHandler, type FetchFn } from "./http-handler";
import { groupTrashObjects, isTrashKey, parseTrashKey, trashKey, TRASH_PREFIX, type TrashGroup } from "./trash";

const log = createLogger("s3-client");

/** Build an S3Client that routes all HTTP through the injected fetch. */
export function createS3Client(
  connection: Pick<Connection, "endpoint" | "region">,
  credentials: Credentials,
  fetchFn: FetchFn,
): S3Client {
  return new S3Client({
    endpoint: connection.endpoint,
    region: connection.region || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: credentials.accessKey,
      secretAccessKey: credentials.secretKey,
    },
    requestHandler: new InjectedFetchHttpHandler(fetchFn),
    // R2 and other S3-compatible endpoints mishandle the SDK's default
    // flexible-checksum middleware (WHEN_SUPPORTED), which wraps the
    // single-shot Tauri body stream and breaks downloads. Integrity is
    // already covered by our own MD5-vs-ETag verification (see
    // download.ts/multipart.ts), so only compute/validate when the caller
    // explicitly requires it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** The `CopySource` value CopyObjectCommand expects: bucket + key,
 * slash-preserving percent-encoded. */
function copySourceFor(bucket: string, key: string): string {
  return `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

function baseName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * List one "folder" level under `prefix` (delimiter "/"). Folders are
 * synthesized from CommonPrefixes and never carry a trailing slash in
 * `name` (the UI must never see storage-style prefix strings).
 */
export async function listEntries(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<RemoteEntry[]> {
  const entries: RemoteEntry[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      if (!cp.Prefix || isTrashKey(cp.Prefix)) continue;
      entries.push({
        kind: "folder",
        name: baseName(cp.Prefix),
        key: cp.Prefix,
      });
    }
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix || isTrashKey(obj.Key)) continue;
      // Skip the zero-byte "folder marker" object matching the prefix itself.
      if (obj.Key.endsWith("/")) continue;
      entries.push({
        kind: "file",
        name: baseName(obj.Key),
        key: obj.Key,
        size: obj.Size,
        lastModified: obj.LastModified?.getTime(),
      });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return entries;
}

export interface RemoteObjectRef {
  key: string;
  size: number;
}

/**
 * Lists every object under `prefix` (no delimiter) one ListObjectsV2 page at
 * a time, yielding each page as soon as it lands instead of returning only
 * once the whole prefix has been enumerated. This is what lets a big-folder
 * copy or delete start working on the first ~1000 keys while the rest are
 * still being listed, rather than sitting through the full listing pass
 * before anything else happens.
 */
async function* pagesUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): AsyncGenerator<RemoteObjectRef[]> {
  // Callers scanning inside the trash location (restoring/purging) need to
  // see trash objects; every other caller (normal browsing/download/rename)
  // must never see them.
  const hideTrash = !isTrashKey(prefix);
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const page: RemoteObjectRef[] = [];
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      if (hideTrash && isTrashKey(obj.Key)) continue;
      page.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    yield page;
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
}

/** List every object under `prefix` (no delimiter), with size — used by
 * recursive folder ops (rename/delete just need the keys; downloads also
 * need each file's size). */
async function listObjectsUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<RemoteObjectRef[]> {
  const objects: RemoteObjectRef[] = [];
  for await (const page of pagesUnder(client, bucket, prefix)) {
    objects.push(...page);
  }
  return objects;
}

/** Recursively lists every real file (not folder markers) under a folder
 * prefix, with sizes — used to enqueue a recursive folder download. */
export async function listFilesUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<RemoteObjectRef[]> {
  const all = await listObjectsUnder(client, bucket, prefix);
  return all.filter((o) => !o.key.endsWith("/"));
}

export interface FolderStats {
  files: number;
  totalSize: number;
  lastModified: number | null;
}

/** Recursively computes file count, total size, and the most recent
 * modification time under a folder prefix — used by the folder info dialog,
 * since S3 "folders" are virtual and carry no metadata of their own. */
export async function folderStats(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<FolderStats> {
  let files = 0;
  let totalSize = 0;
  let lastModified: number | null = null;
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/") || isTrashKey(obj.Key)) continue; // skip folder markers
      files += 1;
      totalSize += obj.Size ?? 0;
      const modified = obj.LastModified?.getTime();
      if (modified !== undefined && (lastModified === null || modified > lastModified)) {
        lastModified = modified;
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return { files, totalSize, lastModified };
}

/** Objects copied at once. A server-side CopyObject moves no bytes through
 * this app — S3 does the work between its own storage nodes — so this is
 * bounded by request overhead, not bandwidth, and can run much higher than a
 * real data-moving transfer would. */
const OBJECT_CONCURRENCY = 24;
/** UploadPartCopy requests in flight per large object. */
const PART_CONCURRENCY = 4;
/** DeleteObjects' maximum batch size. */
const DELETE_BATCH_SIZE = 1000;
/** DeleteObjects batches (each up to DELETE_BATCH_SIZE keys) in flight at once. */
const DELETE_CONCURRENCY = 4;

/**
 * Objects at or above this size are copied as a multipart upload of
 * UploadPartCopy parts rather than one CopyObject.
 *
 * A server-side CopyObject is atomic and silent: it reports nothing until the
 * whole object lands, so a folder of multi-gigabyte files sits at 0% for
 * minutes and then snaps to 100%. Copying in parts lets progress advance as
 * each part completes. It also lifts CopyObject's hard 5 GB ceiling, above
 * which S3 rejects a single-shot copy outright.
 */
export const COPY_MULTIPART_THRESHOLD = 64 * 1024 * 1024;
export const COPY_PART_SIZE = 32 * 1024 * 1024;

/**
 * Progress of a recursive copy, weighted both ways: `copiedBytes` drives a
 * percentage that still moves while a single huge object is in flight, while
 * `copiedItems` drives an "N of M items" label. Callers need both — bytes
 * alone read as nothing on a folder of empty markers, items alone read as
 * nothing on a folder of a few huge files.
 */
export interface CopyProgress {
  copiedBytes: number;
  totalBytes: number;
  copiedItems: number;
  totalItems: number;
}

/** Copy one object to `destKey`, calling `onBytes` with each newly-copied
 * chunk: once with the whole size for a small object, once per part for a
 * large one. */
async function copyObject(
  client: S3Client,
  bucket: string,
  src: RemoteObjectRef,
  destKey: string,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const CopySource = copySourceFor(bucket, src.key);

  if (src.size < COPY_MULTIPART_THRESHOLD) {
    await client.send(new CopyObjectCommand({ Bucket: bucket, CopySource, Key: destKey }));
    onBytes(src.size);
    return;
  }

  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: destKey }),
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error("CreateMultipartUpload did not return an UploadId");

  try {
    const partCount = Math.ceil(src.size / COPY_PART_SIZE);
    const pending = Array.from({ length: partCount }, (_, i) => i + 1);
    const parts: { PartNumber: number; ETag: string }[] = [];
    let failed = false;

    const worker = async (): Promise<void> => {
      while (!failed) {
        const partNumber = pending.shift();
        if (partNumber === undefined) return;
        const start = (partNumber - 1) * COPY_PART_SIZE;
        const end = Math.min(start + COPY_PART_SIZE, src.size) - 1;
        try {
          const res = await client.send(
            new UploadPartCopyCommand({
              Bucket: bucket,
              Key: destKey,
              UploadId: uploadId,
              CopySource,
              CopySourceRange: `bytes=${start}-${end}`,
              PartNumber: partNumber,
            }),
          );
          parts.push({ PartNumber: partNumber, ETag: res.CopyPartResult?.ETag ?? "" });
          onBytes(end - start + 1);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, () => worker()),
    );

    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: destKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    // Never leave a dangling multipart upload behind: its parts occupy (and
    // on most providers bill as) storage until they're aborted.
    try {
      await client.send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId: uploadId }),
      );
    } catch (abortErr) {
      log.warn("AbortMultipartUpload failed", abortErr);
    }
    throw err;
  }
}

/** Copy one key, looking up its size first so large objects take the
 * multipart path. */
async function copyKey(
  client: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
  onBytes: (bytes: number) => void = () => {},
): Promise<void> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fromKey }));
  await copyObject(client, bucket, { key: fromKey, size: head.ContentLength ?? 0 }, toKey, onBytes);
}

/** Copy every object to the key `destKeyFor` maps it to, with bounded
 * parallelism, reporting progress as each object — or each part of a large
 * object — lands rather than at a batch boundary. */
async function copyObjects(
  client: S3Client,
  bucket: string,
  objects: RemoteObjectRef[],
  destKeyFor: (key: string) => string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  const totalItems = objects.length;
  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);
  let copiedItems = 0;
  let copiedBytes = 0;
  const emit = () => onProgress?.({ copiedBytes, totalBytes, copiedItems, totalItems });

  emit(); // tell the UI the totals before the first copy starts

  const pending = objects.slice();
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const obj = pending.shift();
      if (obj === undefined) return;
      try {
        await copyObject(client, bucket, obj, destKeyFor(obj.key), (bytes) => {
          copiedBytes += bytes;
          emit();
        });
        copiedItems++;
        emit();
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(OBJECT_CONCURRENCY, totalItems) }, () => worker()),
  );
}

/** Delete keys in DeleteObjects-sized batches, up to DELETE_CONCURRENCY
 * batches in flight at once. */
async function deleteKeys(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
    batches.push(keys.slice(i, i + DELETE_BATCH_SIZE));
  }
  await mapWithConcurrency(batches, DELETE_CONCURRENCY, (batch) =>
    client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    ),
  );
}

/** A one-shot-per-wait "more might be coming" signal: any number of callers
 * can `wait()`, and a producer's `notifyAll()` wakes every one of them so
 * they can re-check their own condition. Used by the two page-streaming
 * functions below to let their worker pools block on "no work queued yet,
 * but the listing generator isn't done" without polling. */
function createSignal(): { wait(): Promise<void>; notifyAll(): void } {
  const waiters: Array<() => void> = [];
  return {
    wait: () => new Promise((resolve) => waiters.push(resolve)),
    notifyAll: () => {
      while (waiters.length > 0) waiters.shift()!();
    },
  };
}

/**
 * Like copyObjects, but consumes pages from an async generator (see
 * pagesUnder) instead of a fully-listed array, so copying starts as soon as
 * the first page lands instead of after the whole prefix has been
 * enumerated. `totalItems`/`totalBytes` grow as later pages arrive rather
 * than being fixed up front — TransferWidget's movePercent already tolerates
 * a growing total the same way it tolerates bytes landing as parts of one
 * large object complete. Returns every source key seen across every page, so
 * a caller that also needs to delete them afterwards doesn't have to list
 * the prefix a second time.
 */
async function copyObjectsFromPages(
  client: S3Client,
  bucket: string,
  pages: AsyncGenerator<RemoteObjectRef[]>,
  destKeyFor: (key: string) => string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<string[]> {
  const allKeys: string[] = [];
  const pending: RemoteObjectRef[] = [];
  let totalItems = 0;
  let totalBytes = 0;
  let copiedItems = 0;
  let copiedBytes = 0;
  let listingDone = false;
  let failed = false;
  const signal = createSignal();

  const emit = () => onProgress?.({ copiedBytes, totalBytes, copiedItems, totalItems });
  emit(); // tell the UI the (so-far-known) totals before the first copy starts

  const produce = async (): Promise<void> => {
    try {
      for await (const page of pages) {
        if (failed) break;
        for (const obj of page) {
          pending.push(obj);
          allKeys.push(obj.key);
          totalItems += 1;
          totalBytes += obj.size;
        }
        emit();
        signal.notifyAll();
      }
    } catch (err) {
      failed = true;
      signal.notifyAll();
      throw err;
    } finally {
      listingDone = true;
      signal.notifyAll();
    }
  };

  const worker = async (): Promise<void> => {
    while (!failed) {
      const obj = pending.shift();
      if (obj === undefined) {
        if (listingDone) return;
        await signal.wait();
        continue;
      }
      try {
        await copyObject(client, bucket, obj, destKeyFor(obj.key), (bytes) => {
          copiedBytes += bytes;
          emit();
        });
        copiedItems++;
        emit();
      } catch (err) {
        failed = true;
        signal.notifyAll();
        throw err;
      }
    }
  };

  await Promise.all([
    produce(),
    ...Array.from({ length: OBJECT_CONCURRENCY }, () => worker()),
  ]);

  return allKeys;
}

/**
 * Deletes every key across a stream of listing pages (see pagesUnder),
 * batching deletes as pages arrive instead of waiting for the whole prefix
 * to be enumerated first — a ListObjectsV2 page is at most 1000 keys, the
 * same as DeleteObjects' batch cap, so each page is already exactly one
 * delete batch. `onProgress`, when given, is item-count-only: there's
 * nothing copied to weigh bytes against in a pure delete, so
 * copiedBytes/totalBytes stay 0 throughout and only copiedItems/totalItems
 * move, once per completed batch.
 */
async function deleteKeysFromPages(
  client: S3Client,
  bucket: string,
  pages: AsyncGenerator<RemoteObjectRef[]>,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  const pending: string[][] = [];
  let totalItems = 0;
  let deletedItems = 0;
  let listingDone = false;
  let failed = false;
  const signal = createSignal();

  const emit = () =>
    onProgress?.({ copiedBytes: 0, totalBytes: 0, copiedItems: deletedItems, totalItems });
  emit();

  const produce = async (): Promise<void> => {
    try {
      for await (const page of pages) {
        if (failed) break;
        if (page.length === 0) continue;
        totalItems += page.length;
        pending.push(page.map((o) => o.key));
        emit();
        signal.notifyAll();
      }
    } catch (err) {
      failed = true;
      signal.notifyAll();
      throw err;
    } finally {
      listingDone = true;
      signal.notifyAll();
    }
  };

  const worker = async (): Promise<void> => {
    while (!failed) {
      const batch = pending.shift();
      if (batch === undefined) {
        if (listingDone) return;
        await signal.wait();
        continue;
      }
      try {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        );
        deletedItems += batch.length;
        emit();
      } catch (err) {
        failed = true;
        signal.notifyAll();
        throw err;
      }
    }
  };

  await Promise.all([
    produce(),
    ...Array.from({ length: DELETE_CONCURRENCY }, () => worker()),
  ]);
}

/** Rename a file: copy it to the new key, then delete the old one. */
export async function renameFile(
  client: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fromKey }));
  const totalBytes = head.ContentLength ?? 0;
  let copiedBytes = 0;
  onProgress?.({ copiedBytes: 0, totalBytes, copiedItems: 0, totalItems: 1 });

  await copyObject(client, bucket, { key: fromKey, size: totalBytes }, toKey, (bytes) => {
    copiedBytes += bytes;
    onProgress?.({ copiedBytes, totalBytes, copiedItems: 0, totalItems: 1 });
  });
  onProgress?.({ copiedBytes: totalBytes, totalBytes, copiedItems: 1, totalItems: 1 });

  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

/** Rename a folder: copy every key under the old prefix to the new one, then
 * delete the originals in bulk. */
export async function renameFolder(
  client: S3Client,
  bucket: string,
  fromPrefix: string,
  toPrefix: string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  const objects = await listObjectsUnder(client, bucket, fromPrefix);
  if (objects.length === 0) return;

  await copyObjects(
    client,
    bucket,
    objects,
    (key) => toPrefix + key.slice(fromPrefix.length),
    onProgress,
  );
  await deleteKeys(client, bucket, objects.map((o) => o.key));
}

/** Delete a single file. */
export async function deleteFile(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Moves a single file to the trash location: copy it there, then delete the
 * original. */
export async function moveFileToTrash(
  client: S3Client,
  bucket: string,
  key: string,
  deletedAtMs: number,
): Promise<void> {
  await copyKey(client, bucket, key, trashKey(deletedAtMs, key));
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/**
 * Moves every object under a folder to the trash location, sharing one
 * `deletedAtMs` so the trash view can group them back into a single row.
 *
 * Writes the folder's own zero-byte trash marker *before* copying any
 * children, unconditionally — even when the source folder already has its
 * own marker object, which this then just recopies over it below (a copy of
 * a zero-byte object onto itself is a no-op). This is the fix for the
 * "loose files in Trash" race: groupTrashObjects (trash.ts) can only collapse
 * children under one folder row once the marker exists at the trash
 * location, so writing it last (the old order) meant every listing of the
 * Trash while a big move was still copying showed each child as its own row
 * until the marker finally landed. Writing it first is safe even if a
 * restore races this move mid-copy: originals are deleted last, so
 * existsUnderPrefix's conflict guard still sees them and blocks the restore.
 */
export async function moveFolderToTrash(
  client: S3Client,
  bucket: string,
  prefix: string,
  deletedAtMs: number,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: trashKey(deletedAtMs, prefix),
      Body: new Uint8Array(0),
    }),
  );

  const keys = await copyObjectsFromPages(
    client,
    bucket,
    pagesUnder(client, bucket, prefix),
    (key) => trashKey(deletedAtMs, key),
    onProgress,
  );

  await deleteKeys(client, bucket, keys);
}

const RESTORE_CONFLICT_MESSAGE =
  "Something's already there — restore skipped, the trashed copy is untouched.";

async function existsAtKey(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    log.warn("existsAtKey failed", err);
    return false;
  }
}

async function existsUnderPrefix(client: S3Client, bucket: string, prefix: string): Promise<boolean> {
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }),
  );
  return (res.Contents?.length ?? 0) > 0 || (res.KeyCount ?? 0) > 0;
}

/** Restores a single trashed file back to its original path. Throws a plain
 * Error (not a raw SDK error) if something already lives there — the
 * trashed copy is left untouched either way. */
export async function restoreFileFromTrash(
  client: S3Client,
  bucket: string,
  deletedAtMs: number,
  originalKey: string,
): Promise<void> {
  if (await existsAtKey(client, bucket, originalKey)) {
    throw new Error(RESTORE_CONFLICT_MESSAGE);
  }
  const src = trashKey(deletedAtMs, originalKey);
  await copyKey(client, bucket, src, originalKey);
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: src }));
}

/** Restores every object trashed together as one folder back under its
 * original path. Throws a plain Error, leaving the trashed copy untouched,
 * if anything already lives at that path. Streams listing pages straight
 * into the copy pool (so a big restore starts moving bytes after the first
 * page instead of after the whole trashed folder has been enumerated) and
 * collects every copied key along the way, so the final delete pass needs no
 * second listing. Copying everything before deleting anything is kept
 * (rather than deleting each key right after its own copy) so a crash
 * mid-restore leaves the trashed copy intact instead of half-gone. */
export async function restoreFolderFromTrash(
  client: S3Client,
  bucket: string,
  deletedAtMs: number,
  originalPrefix: string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  if (await existsUnderPrefix(client, bucket, originalPrefix)) {
    throw new Error(RESTORE_CONFLICT_MESSAGE);
  }
  const groupPrefix = trashKey(deletedAtMs, originalPrefix);

  const trashedKeys = await copyObjectsFromPages(
    client,
    bucket,
    pagesUnder(client, bucket, groupPrefix),
    (key) => originalPrefix + key.slice(groupPrefix.length),
    onProgress,
  );

  await deleteKeys(client, bucket, trashedKeys);
}

/** Permanently deletes one trashed row — every object under it if it was a
 * folder, the single trashed object otherwise. */
export async function deleteTrashItem(
  client: S3Client,
  bucket: string,
  deletedAtMs: number,
  originalKey: string,
  kind: "file" | "folder",
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  if (kind === "file") {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: trashKey(deletedAtMs, originalKey) }),
    );
    return;
  }
  const groupPrefix = trashKey(deletedAtMs, originalKey);
  await deleteKeysFromPages(client, bucket, pagesUnder(client, bucket, groupPrefix), onProgress);
}

/** Every trashed item, grouped into one row per originally-deleted file or folder. */
export async function listTrash(client: S3Client, bucket: string): Promise<TrashGroup[]> {
  const objects: { key: string; size: number }[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: TRASH_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) objects.push({ key: obj.Key, size: obj.Size ?? 0 });
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  const parsed = objects.flatMap(({ key, size }) => {
    const p = parseTrashKey(key);
    return p ? [{ trashKey: key, originalKey: p.originalKey, deletedAtMs: p.deletedAtMs, size }] : [];
  });
  return groupTrashObjects(parsed);
}

/** Permanently empties the entire trash. */
export async function emptyTrash(
  client: S3Client,
  bucket: string,
  onProgress?: (progress: CopyProgress) => void,
): Promise<void> {
  await deleteKeysFromPages(client, bucket, pagesUnder(client, bucket, TRASH_PREFIX), onProgress);
}

/** Create a zero-byte "folder marker" object ending in "/". */
export async function createFolder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<void> {
  const key = prefix.endsWith("/") ? prefix : `${prefix}/`;
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: new Uint8Array(0) }),
  );
}

/** SigV4's hard ceiling on presigned URL lifetime — AWS (and S3-compatible
 * stores like MinIO) reject anything past this. Callers must pick an expiry
 * at or under this value. */
const MAX_COPY_LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Presigned GET URL, valid for `expiresInSeconds` (capped at
 * MAX_COPY_LINK_EXPIRY_SECONDS, SigV4's hard maximum). */
export async function copyLink(
  client: S3Client,
  bucket: string,
  key: string,
  expiresInSeconds: number,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const expiresIn = Math.min(expiresInSeconds, MAX_COPY_LINK_EXPIRY_SECONDS);
  return getSignedUrl(client, command, { expiresIn });
}

export type TestConnectionResult = { ok: true } | { ok: false; error: PlainError };

/**
 * Test connection: small write + read + delete of a probe key. Never
 * throws — failures come back as a PlainError for the setup screen.
 */
export async function testConnection(
  client: S3Client,
  bucket: string,
): Promise<TestConnectionResult> {
  const probeKey = `.lopload-connection-test-${Date.now()}`;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: probeKey,
        Body: new Uint8Array([0]),
      }),
    );
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: probeKey }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
    return { ok: true };
  } catch (err) {
    // Best-effort cleanup even on failure paths that got past the write.
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
    } catch {
      // ignored — probe key may never have been created
    }
    return { ok: false, error: toPlainError(err) };
  }
}
