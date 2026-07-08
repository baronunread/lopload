// Integration tests against a real MinIO container (docker), exercising the
// actual engine code with global fetch and in-memory stores — no mocks.
// Skips cleanly if docker is unavailable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import { TransferEngine } from "../../src/lib/engine";
import { createS3Client } from "../../src/lib/s3/client";
import { testConnection } from "../../src/lib/s3/client";
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

  test("larger file upload verifies and matches bytes exactly", async () => {
    if (!minio) return;
    const size = 5 * 1024 * 1024; // ~5 MiB
    const bytes = randomBytes(size);
    const path = join(workdir, "medium.bin");
    await writeFile(path, bytes);

    const store = new MemoryTransferStore();
    const engine = makeEngine(minio.client, store, "conn-large");

    const [created] = await engine.enqueue([
      { localPath: path, size, key: "medium/medium.bin" },
    ]);

    await waitForTerminal(engine, created.id, 30_000);
    const final = engine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("uploaded");

    const remoteBytes = await readObjectBytes(minio.client, "medium/medium.bin");
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
