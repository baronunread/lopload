// Integration tests against a real MinIO container (docker), exercising the
// actual download engine code with global fetch and in-memory stores — no
// mocks. Skips cleanly if docker is unavailable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { TransferEngine } from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { localFileReader } from "./localFileReader";
import { localFileWriter } from "./localFileWriter";
import { startMinio, TEST_BUCKET, type MinioHandle } from "./minio";

let minio: MinioHandle | null = null;
let workdir = "";

beforeAll(async () => {
  minio = await startMinio();
  if (!minio) {
    console.warn(
      "[integration] docker is unavailable — skipping MinIO download integration tests.",
    );
    return;
  }
  workdir = await mkdtemp(join(tmpdir(), "lopload-int-dl-"));
}, 120_000);

afterAll(async () => {
  if (minio) await minio.stop();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

function md5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function makeEngine(store: MemoryTransferStore, connectionId = "conn-dl-1") {
  return new TransferEngine({
    client: minio!.client,
    bucket: TEST_BUCKET,
    connectionId,
    reader: localFileReader,
    writer: localFileWriter,
    store,
  });
}

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
    return t?.state.kind === "downloaded" || t?.state.kind === "failed";
  }, timeoutMs);
}

describe("MinIO download integration", () => {
  test("small file downloads and matches bytes exactly", async () => {
    if (!minio) return;
    const bytes = randomBytes(2048);
    const key = "downloads/small.bin";
    await minio.client.send(
      new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: bytes }),
    );

    const store = new MemoryTransferStore();
    const engine = makeEngine(store);
    const localPath = join(workdir, "small-download.bin");

    const [created] = await engine.enqueueDownloads([
      { localPath, size: bytes.length, key },
    ]);

    await waitForTerminal(engine, created.id);
    const final = engine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("downloaded");

    const downloaded = await readFile(localPath);
    expect(Buffer.from(bytes).equals(downloaded)).toBe(true);
    expect(md5(downloaded)).toBe(md5(bytes));
  }, 30_000);

  test("larger file downloads and matches bytes exactly", async () => {
    if (!minio) return;
    const size = 5 * 1024 * 1024; // ~5 MiB
    const bytes = randomBytes(size);
    const key = "downloads/medium.bin";
    await minio.client.send(
      new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: bytes }),
    );

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-dl-medium");
    const localPath = join(workdir, "medium-download.bin");

    const [created] = await engine.enqueueDownloads([
      { localPath, size: bytes.length, key },
    ]);

    await waitForTerminal(engine, created.id, 60_000);
    const final = engine.getTransfer(created.id)!;
    expect(final.state.kind).toBe("downloaded");

    const downloaded = await readFile(localPath);
    expect(downloaded.length).toBe(bytes.length);
    expect(md5(downloaded)).toBe(md5(bytes));
  }, 90_000);

  test("cancelled download never reaches downloaded and leaves no temp file behind", async () => {
    if (!minio) return;
    const size = 8 * 1024 * 1024; // large enough to still be in-flight when cancelled
    const bytes = randomBytes(size);
    const key = "downloads/cancel-me.bin";
    await minio.client.send(
      new PutObjectCommand({ Bucket: TEST_BUCKET, Key: key, Body: bytes }),
    );

    const store = new MemoryTransferStore();
    const engine = makeEngine(store, "conn-dl-cancel");
    const localPath = join(workdir, "cancel-download.bin");

    const [created] = await engine.enqueueDownloads([
      { localPath, size: bytes.length, key },
    ]);

    // Cancel almost immediately — the transfer should never settle into
    // "downloaded".
    await engine.cancel(created.id);

    await new Promise((r) => setTimeout(r, 2000));
    const final = engine.getTransfer(created.id);
    expect(final?.state.kind).not.toBe("downloaded");

    await expect(readFile(localPath)).rejects.toThrow();
    await expect(readFile(`${localPath}.lopload-download`)).rejects.toThrow();
  }, 30_000);
});
