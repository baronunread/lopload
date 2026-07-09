// Stateful fake S3 backend for the service conformance suite — wires
// aws-sdk-client-mock's callsFake handlers to an in-memory, per-bucket
// object map so src/lib/s3/client.ts's real listing/rename/delete/copyLink
// code runs against genuine (if fake) S3 semantics instead of one-off fixed
// responses.
//
// Shared "fail" convention: a PutObjectCommand whose Key or Bucket contains
// the substring "fail" (case-insensitive) rejects — this lets the
// conformance suite force a failure via a plain, memorable key/bucket name.
//
// Shared "slow" convention: a PutObjectCommand/GetObjectCommand whose Key
// contains "slow" is delayed a little, giving cancel() tests a real window
// to land before the transfer would otherwise complete.
import { mockClient } from "aws-sdk-client-mock";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import { createCRC32 } from "hash-wasm";
import { md5Hex } from "../../../src/lib/md5";

interface StoredObject {
  body: Uint8Array;
  etag: string;
  lastModified: Date;
}

function partitionKey(bucket: string, key: string): string {
  return `${bucket}::${key}`;
}

function shouldFail(...values: (string | undefined)[]): boolean {
  return values.some((v) => v?.toLowerCase().includes("fail"));
}

const SLOW_DELAY_MS = 60;

async function crc32Base64(bytes: Uint8Array): Promise<string> {
  const h = await createCRC32();
  h.init();
  h.update(bytes);
  const raw = h.digest("binary") as Uint8Array;
  return btoa(String.fromCharCode(...raw));
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
  return new Uint8Array(0);
}

async function delayIfSlow(key: string | undefined): Promise<void> {
  if (key?.toLowerCase().includes("slow")) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
  }
}

export function installFakeS3(client: S3Client) {
  const s3Mock = mockClient(client);
  const objects = new Map<string, StoredObject>();

  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    await delayIfSlow(input.Key);
    if (shouldFail(input.Key, input.Bucket)) {
      const err = new Error("Simulated AccessDenied");
      err.name = "AccessDenied";
      (err as { $metadata?: unknown }).$metadata = { httpStatusCode: 403 };
      throw err;
    }
    const body = await bodyToBytes(input.Body);
    const etag = `"${await md5Hex(body)}"`;
    const crc32 = await crc32Base64(body);
    objects.set(partitionKey(input.Bucket!, input.Key!), {
      body,
      etag,
      lastModified: new Date(),
    });
    return { ETag: etag, ChecksumCRC32: crc32 };
  });

  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    await delayIfSlow(input.Key);
    const obj = objects.get(partitionKey(input.Bucket!, input.Key!));
    if (!obj) {
      const err = new Error("The specified key does not exist.");
      err.name = "NoSuchKey";
      (err as { $metadata?: unknown }).$metadata = { httpStatusCode: 404 };
      throw err;
    }
    return { Body: obj.body, ETag: obj.etag, ContentLength: obj.body.length };
  });

  s3Mock.on(HeadObjectCommand).callsFake(async (input) => {
    const obj = objects.get(partitionKey(input.Bucket!, input.Key!));
    if (!obj) {
      const err = new Error("Not Found");
      err.name = "NotFound";
      (err as { $metadata?: unknown }).$metadata = { httpStatusCode: 404 };
      throw err;
    }
    return { ContentLength: obj.body.length, ETag: obj.etag, LastModified: obj.lastModified };
  });

  s3Mock.on(DeleteObjectCommand).callsFake(async (input) => {
    objects.delete(partitionKey(input.Bucket!, input.Key!));
    return {};
  });

  s3Mock.on(DeleteObjectsCommand).callsFake(async (input) => {
    for (const o of input.Delete?.Objects ?? []) {
      if (o.Key) objects.delete(partitionKey(input.Bucket!, o.Key));
    }
    return {};
  });

  s3Mock.on(CopyObjectCommand).callsFake(async (input) => {
    const rawSource = String(input.CopySource);
    const withoutBucket = rawSource.slice(rawSource.indexOf("/", 1) + 1);
    const sourceKey = decodeURIComponent(withoutBucket);
    const obj = objects.get(partitionKey(input.Bucket!, sourceKey));
    if (obj) objects.set(partitionKey(input.Bucket!, input.Key!), { ...obj });
    return {};
  });

  s3Mock.on(ListObjectsV2Command).callsFake(async (input) => {
    const bucket = input.Bucket!;
    const prefix = input.Prefix ?? "";
    const delimiter = input.Delimiter;
    const bucketPrefix = `${bucket}::`;
    const keys = Array.from(objects.keys())
      .filter((k) => k.startsWith(bucketPrefix))
      .map((k) => k.slice(bucketPrefix.length))
      .filter((k) => k.startsWith(prefix))
      .sort();

    const contents: { Key: string; Size: number; LastModified: Date; ETag: string }[] = [];
    const commonPrefixes = new Set<string>();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        const idx = rest.indexOf(delimiter);
        commonPrefixes.add(prefix + rest.slice(0, idx + 1));
        continue;
      }
      const obj = objects.get(partitionKey(bucket, key))!;
      contents.push({ Key: key, Size: obj.body.length, LastModified: obj.lastModified, ETag: obj.etag });
    }

    return {
      Contents: contents,
      CommonPrefixes: Array.from(commonPrefixes).map((p) => ({ Prefix: p })),
      IsTruncated: false,
    };
  });

  return {
    s3Mock,
    objects,
    reset(): void {
      objects.clear();
    },
  };
}
