// Opt-in e2e suite against a REAL bucket (R2, S3, or any S3-compatible
// endpoint), exercising the actual engine/client code — no mocks, no MinIO.
// Skips cleanly (with a console.warn) unless every LOPLOAD_E2E_* env var is
// set; see .env.e2e.example and package.json's "test:e2e" script.
//
// Safety: every object this suite touches lives under a unique run prefix
// (`e2e-<timestamp>-<rand>/`). afterAll deletes everything under that prefix
// and nothing else — pre-existing objects in the bucket are never touched.
// Tests run serially (bun's default within a file) and use generous timeouts
// since real endpoints are slower and less predictable than local MinIO.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

import { TransferEngine } from "../../src/lib/engine";
import {
  createFolder,
  deleteFile,
  deleteFolder,
  listEntries,
  renameFile,
  testConnection,
} from "../../src/lib/s3/client";
import { MULTIPART_THRESHOLD } from "../../src/lib/s3/multipart";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { localFileReader } from "../integration/localFileReader";
import { localFileWriter } from "../integration/localFileWriter";
import { realBucket, type RealBucketHandle } from "./realBucket";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

let handle: RealBucketHandle | null = null;
let runPrefix = "";
let workdir = "";

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

beforeAll(async () => {
  handle = realBucket();
  if (!handle) return;
  runPrefix = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
  workdir = await mkdtemp(join(tmpdir(), "lopload-e2e-"));
}, 30_000);

afterAll(async () => {
  if (handle && runPrefix) {
    // Delete everything created under this run's prefix — never anything
    // outside it.
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await handle.client.send(
        new ListObjectsV2Command({
          Bucket: handle.bucket,
          Prefix: runPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await handle.client.send(
        new DeleteObjectsCommand({
          Bucket: handle.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
    }
  }
  if (workdir) await rm(workdir, { recursive: true, force: true });
}, 60_000);

function makeEngine(store: MemoryTransferStore, connectionId: string) {
  return new TransferEngine({
    client: handle!.client,
    bucket: handle!.bucket,
    connectionId,
    reader: localFileReader,
    writer: localFileWriter,
    store,
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil: condition never became true within timeout");
}

describe("real bucket e2e", () => {
  test("testConnection succeeds against the real bucket", async () => {
    if (!handle) return;
    const result = await testConnection(handle.client, handle.bucket);
    expect(result.ok).toBe(true);
  }, 30_000);

  test("small file upload + download round-trips with matching bytes/MD5", async () => {
    if (!handle) return;
    const bytes = randomBytes(4096);
    const key = `${runPrefix}small.bin`;
    const uploadPath = join(workdir, "small-upload.bin");
    const downloadPath = join(workdir, "small-download.bin");
    await writeFile(uploadPath, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-e2e-small");

    const [uploaded] = await engine.enqueue([
      { localPath: uploadPath, size: bytes.length, key },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(uploaded.id);
      return t?.state.kind === "uploaded" || t?.state.kind === "failed";
    }, 60_000);
    expect(engine.getTransfer(uploaded.id)!.state.kind).toBe("uploaded");

    const [downloaded] = await engine.enqueueDownloads([
      { localPath: downloadPath, size: bytes.length, key },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(downloaded.id);
      return t?.state.kind === "downloaded" || t?.state.kind === "failed";
    }, 60_000);
    expect(engine.getTransfer(downloaded.id)!.state.kind).toBe("downloaded");

    const roundTripped = await readFile(downloadPath);
    expect(md5(roundTripped)).toBe(md5(bytes));
  }, 120_000);

  test("multipart-sized upload + download round-trips with matching bytes/MD5", async () => {
    if (!handle) return;
    const size = MULTIPART_THRESHOLD + 4 * 1024 * 1024; // forces multipart
    const bytes = randomBytes(size);
    const key = `${runPrefix}multipart.bin`;
    const uploadPath = join(workdir, "multipart-upload.bin");
    const downloadPath = join(workdir, "multipart-download.bin");
    await writeFile(uploadPath, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-e2e-multipart");

    const [uploaded] = await engine.enqueue([
      { localPath: uploadPath, size: bytes.length, key },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(uploaded.id);
      return t?.state.kind === "uploaded" || t?.state.kind === "failed";
    }, 180_000);
    expect(engine.getTransfer(uploaded.id)!.state.kind).toBe("uploaded");

    const [downloaded] = await engine.enqueueDownloads([
      { localPath: downloadPath, size: bytes.length, key },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(downloaded.id);
      return t?.state.kind === "downloaded" || t?.state.kind === "failed";
    }, 180_000);
    expect(engine.getTransfer(downloaded.id)!.state.kind).toBe("downloaded");

    const roundTripped = await readFile(downloadPath);
    expect(roundTripped.length).toBe(bytes.length);
    expect(md5(roundTripped)).toBe(md5(bytes));
  }, 300_000);

  test("list with delimiter returns synthesized folders and files", async () => {
    if (!handle) return;
    const folderPrefix = `${runPrefix}listing/`;
    await createFolder(handle.client, handle.bucket, `${folderPrefix}sub`);

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-e2e-listing");
    const filePath = join(workdir, "listing-file.bin");
    await writeFile(filePath, randomBytes(256));
    const fileKey = `${folderPrefix}file.bin`;
    const [uploaded] = await engine.enqueue([
      { localPath: filePath, size: 256, key: fileKey },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(uploaded.id);
      return t?.state.kind === "uploaded" || t?.state.kind === "failed";
    }, 60_000);
    expect(engine.getTransfer(uploaded.id)!.state.kind).toBe("uploaded");

    const entries = await listEntries(handle.client, handle.bucket, folderPrefix);
    expect(entries.some((e) => e.kind === "folder" && e.name === "sub")).toBe(true);
    expect(entries.some((e) => e.kind === "file" && e.name === "file.bin")).toBe(true);
  }, 90_000);

  test("rename and delete a file", async () => {
    if (!handle) return;
    const bytes = randomBytes(512);
    const path = join(workdir, "rename-me.bin");
    await writeFile(path, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-e2e-rename");
    const fromKey = `${runPrefix}rename-from.bin`;
    const toKey = `${runPrefix}rename-to.bin`;

    const [uploaded] = await engine.enqueue([
      { localPath: path, size: bytes.length, key: fromKey },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(uploaded.id);
      return t?.state.kind === "uploaded" || t?.state.kind === "failed";
    }, 60_000);
    expect(engine.getTransfer(uploaded.id)!.state.kind).toBe("uploaded");

    await renameFile(handle.client, handle.bucket, fromKey, toKey);

    const afterRename = await listEntries(handle.client, handle.bucket, runPrefix);
    expect(afterRename.some((e) => e.key === toKey)).toBe(true);
    expect(afterRename.some((e) => e.key === fromKey)).toBe(false);

    await deleteFile(handle.client, handle.bucket, toKey);
    const afterDelete = await listEntries(handle.client, handle.bucket, runPrefix);
    expect(afterDelete.some((e) => e.key === toKey)).toBe(false);
  }, 90_000);

  test("delete a folder removes every object under its prefix", async () => {
    if (!handle) return;
    const folderPrefix = `${runPrefix}to-delete/`;
    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-e2e-delete-folder");
    const path = join(workdir, "delete-folder-file.bin");
    await writeFile(path, randomBytes(128));
    const key = `${folderPrefix}file.bin`;

    const [uploaded] = await engine.enqueue([
      { localPath: path, size: 128, key },
    ]);
    await waitUntil(() => {
      const t = engine.getTransfer(uploaded.id);
      return t?.state.kind === "uploaded" || t?.state.kind === "failed";
    }, 60_000);
    expect(engine.getTransfer(uploaded.id)!.state.kind).toBe("uploaded");

    await deleteFolder(handle.client, handle.bucket, folderPrefix);
    const after = await listEntries(handle.client, handle.bucket, folderPrefix);
    expect(after.length).toBe(0);
  }, 90_000);
});
