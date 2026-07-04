// Factory for S3Client + browse/rename/delete/createFolder/copyLink/testConnection
// helpers. All S3 access in this app goes through a client built here so the
// fetch implementation (and therefore the CORS bypass) stays dependency-injected.

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Connection, Credentials, PlainError, RemoteEntry } from "../types";
import { toPlainError } from "../errors";
import { InjectedFetchHttpHandler, type FetchFn } from "./http-handler";

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
  });
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
      if (!cp.Prefix) continue;
      entries.push({
        kind: "folder",
        name: baseName(cp.Prefix),
        key: cp.Prefix,
      });
    }
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
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

/** List every key under `prefix` (no delimiter) — used by recursive folder ops. */
async function listAllKeysUnder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
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
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Rename a file: CopyObject to the new key, then DeleteObject the old one. */
export async function renameFile(
  client: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `/${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
      Key: toKey,
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

/** Rename a folder: copy+delete every key under the old prefix to the new one. */
export async function renameFolder(
  client: S3Client,
  bucket: string,
  fromPrefix: string,
  toPrefix: string,
): Promise<void> {
  const keys = await listAllKeysUnder(client, bucket, fromPrefix);
  for (const key of keys) {
    const newKey = toPrefix + key.slice(fromPrefix.length);
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
        Key: newKey,
      }),
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}

/** Delete a single file. */
export async function deleteFile(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Recursively delete every key under a folder prefix. */
export async function deleteFolder(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<void> {
  const keys = await listAllKeysUnder(client, bucket, prefix);
  if (keys.length === 0) return;
  const CHUNK = 1000; // DeleteObjects max batch size
  for (let i = 0; i < keys.length; i += CHUNK) {
    const batch = keys.slice(i, i + CHUNK);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })) },
      }),
    );
  }
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

const COPY_LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Presigned GET URL, valid for 7 days. */
export async function copyLink(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, command, { expiresIn: COPY_LINK_EXPIRY_SECONDS });
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
