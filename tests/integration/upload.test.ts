// Integration tests against a real MinIO container (docker), exercising the
// actual engine/multipart/verify/orphan-sweep code with global fetch and
// in-memory stores — no mocks. Skips cleanly if docker is unavailable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import { TransferEngine } from "../../src/lib/engine";
import { createS3Client } from "../../src/lib/s3/client";
import { testConnection } from "../../src/lib/s3/client";
import { sweepOrphans } from "../../src/lib/s3/orphans";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";
import { localFileReader } from "./localFileReader";
import { startMinio, TEST_CREDENTIALS, TEST_BUCKET, type MinioHandle } from "./minio";

let minio: MinioHandle | null = null;
let workdir = "";

beforeAll(async () => {
  minio = await startMinio();
  if (!minio) {
    console.warn(
      "[integration] docker is unavailable — skipping MinIO integration tests.",
    );
    return;
  }
  workdir = await mkdtemp(join(tmpdir(), "lopload-int-"));
}, 120_000);

afterAll(async () => {
  if (minio) await minio.stop();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function readObjectBytes(client: S3Client, key: string): Promise<Uint8Array> {
  const res = await client.send(new GetObjectCommand({ Bucket: TEST_BUCKET, Key: key }));
  const body = res.Body;
  if (!body) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  // @ts-expect-error - Node/Bun Body is an async iterable of Uint8Array chunks.
  for await (const chunk of body) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function makeEngine(client: S3Client, store: MemoryTransferStore, connectionId = "conn-1") {
  return new TransferEngine({
    client,
    bucket: TEST_BUCKET,
    connectionId,
    reader: localFileReader,
    store,
  });
}

describe("MinIO integration", () => {
  test("small file upload verifies and matches bytes exactly", async () => {
    if (!minio) return;
    const bytes = randomBytes(2048);
    const path = join(workdir, "small.bin");
    await writeFile(path, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(minio.client, store);

    const updates: Transfer[] = [];
    engine.subscribe((e) => {
      if (e.type === "transfer-updated") updates.push(e.transfer);
    });

    const [created] = await engine.enqueue([
      { localPath: path, size: bytes.length, key: "small/small.bin" },
    ]);

    await waitForTerminal(engine, created.id);
    const final = engine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("uploaded");

    const remoteBytes = await readObjectBytes(minio.client, "small/small.bin");
    expect(Buffer.from(remoteBytes).equals(bytes)).toBe(true);
  }, 30_000);

  test("large multipart upload with simulated restart resumes, completes, and matches bytes exactly", async () => {
    if (!minio) return;
    const size = 40 * 1024 * 1024; // ~40 MiB, well above the 16 MiB threshold
    const bytes = randomBytes(size);
    const path = join(workdir, "large.bin");
    await writeFile(path, bytes);

    const store = new MemoryTransferStore();

    // --- "First run": a reader that fails partway through (after the first
    // part has already been read/uploaded) so the engine persists part 1
    // and the multipart uploadId, then marks the transfer failed — exactly
    // what a crash mid-upload leaves behind on disk. ---
    let readCount = 0;
    const flakyReader = {
      size: localFileReader.size,
      async readChunk(p: string, offset: number, length: number) {
        readCount += 1;
        if (readCount === 2) {
          throw new Error("simulated crash mid-upload");
        }
        return localFileReader.readChunk(p, offset, length);
      },
    };

    const firstEngine = new TransferEngine({
      client: minio.client,
      bucket: TEST_BUCKET,
      connectionId: "conn-large",
      reader: flakyReader,
      store,
    });
    const [created] = await firstEngine.enqueue([
      { localPath: path, size, key: "large/large.bin" },
    ]);

    await waitUntil(() => firstEngine.getTransfer(created.id)?.state.kind === "failed", 30_000);

    const midway = await store.get(created.id);
    expect(midway?.uploadId).toBeTruthy();
    const midwayParts = await store.listParts(created.id);
    expect(midwayParts.length).toBeGreaterThan(0);

    // --- "Restart": fresh engine instance, same store, real (non-flaky)
    // reader — resume the failed transfer from persisted parts. ---
    const resumedEngine = makeEngine(minio.client, store, "conn-large");
    await resumedEngine.resumePending();
    await resumedEngine.retry(created.id);

    await waitForTerminal(resumedEngine, created.id, 60_000);
    const final = resumedEngine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("uploaded");

    const remoteBytes = await readObjectBytes(minio.client, "large/large.bin");
    expect(remoteBytes.length).toBe(bytes.length);
    expect(Buffer.from(remoteBytes).equals(bytes)).toBe(true);
  }, 90_000);

  test("mismatched expected size ends in failed with errorClass verification, never uploaded", async () => {
    if (!minio) return;
    const bytes = randomBytes(4096);
    const path = join(workdir, "mismatch.bin");
    await writeFile(path, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(minio.client, store, "conn-mismatch");

    // Enqueue with a declared size larger than what's actually on disk —
    // the engine reads the declared size worth of bytes (short read, since
    // the file is smaller), so the uploaded object's real size will not
    // match what we told the engine to expect, and verification must fail.
    const [created] = await engine.enqueue([
      { localPath: path, size: bytes.length + 500, key: "mismatch/file.bin" },
    ]);

    await waitForTerminal(engine, created.id, 30_000);
    const final = engine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("failed");
    if (final.state.kind === "failed") {
      expect(final.state.errorClass).toBe("verification");
    }
    expect(final.state.kind).not.toBe("uploaded");
  }, 30_000);

  test("orphan sweep aborts only the untracked multipart session", async () => {
    if (!minio) return;
    const client = minio.client;
    const store = new MemoryTransferStore();

    // Untracked: a raw CreateMultipartUpload with no matching store row.
    const { CreateMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    const untracked = await client.send(
      new CreateMultipartUploadCommand({ Bucket: TEST_BUCKET, Key: "orphans/untracked.bin" }),
    );
    const untrackedUploadId = untracked.UploadId!;

    // Tracked: another raw CreateMultipartUpload, but this time recorded in
    // the store as if a real transfer owns it.
    const tracked = await client.send(
      new CreateMultipartUploadCommand({ Bucket: TEST_BUCKET, Key: "orphans/tracked.bin" }),
    );
    const trackedUploadId = tracked.UploadId!;
    const now = Date.now();
    await store.save({
      id: "tracked-transfer",
      connectionId: "conn-orphans",
      key: "orphans/tracked.bin",
      localPath: "/dev/null",
      size: 100,
      partSize: 8 * 1024 * 1024,
      uploadId: trackedUploadId,
      state: { kind: "sending", percent: 0 },
      createdAt: now,
      updatedAt: now,
    });

    await sweepOrphans(client, store, "conn-orphans", TEST_BUCKET, Date.now(), 0);

    const listing = await client.send(
      new ListMultipartUploadsCommand({ Bucket: TEST_BUCKET }),
    );
    const remainingIds = new Set((listing.Uploads ?? []).map((u) => u.UploadId));

    expect(remainingIds.has(untrackedUploadId)).toBe(false);
    expect(remainingIds.has(trackedUploadId)).toBe(true);

    // Clean up the tracked session so it doesn't linger across test runs.
    const { AbortMultipartUploadCommand } = await import("@aws-sdk/client-s3");
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: TEST_BUCKET,
        Key: "orphans/tracked.bin",
        UploadId: trackedUploadId,
      }),
    );
  }, 30_000);

  test("testConnection succeeds with good credentials", async () => {
    if (!minio) return;
    const result = await testConnection(minio.client, TEST_BUCKET);
    expect(result.ok).toBe(true);
  }, 15_000);

  test("testConnection fails with a plain-language message on bad credentials", async () => {
    if (!minio) return;
    const badClient = createS3Client(
      minio.connection,
      { accessKey: "wrong", secretKey: "wrong-too" },
      fetch,
    );
    const result = await testConnection(badClient, TEST_BUCKET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.length).toBeGreaterThan(0);
      // Plain language: no raw SDK/XML jargon leaking through.
      expect(result.error.message.toLowerCase()).not.toContain("xml");
      expect(result.error.message.toLowerCase()).not.toContain("<?xml");
    }
  }, 15_000);
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitUntil: condition never became true within timeout");
}

async function waitForTerminal(
  engine: TransferEngine,
  transferId: string,
  timeoutMs = 30_000,
): Promise<void> {
  await waitUntil(() => {
    const t = engine.getTransfer(transferId);
    return t?.state.kind === "uploaded" || t?.state.kind === "failed";
  }, timeoutMs);
}
