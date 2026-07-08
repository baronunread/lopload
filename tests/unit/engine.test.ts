import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { createCRC32 } from "hash-wasm";

import {
  STATE_TRANSITIONS,
  TransferEngine,
  canTransition,
} from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { EngineEvent, Transfer, TransferState } from "../../src/lib/types";
import type { LocalFileReader } from "../../src/lib/s3/multipart";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

function makeReader(files: Record<string, Uint8Array>): LocalFileReader {
  return {
    async size(path) {
      return files[path]?.length ?? 0;
    },
    async readChunk(path, offset, length) {
      const bytes = files[path] ?? new Uint8Array(0);
      return bytes.slice(offset, offset + length);
    },
  };
}

async function crc32Base64(bytes: Uint8Array): Promise<string> {
  const h = await createCRC32();
  h.init();
  h.update(bytes);
  const raw = h.digest("binary") as Uint8Array;
  return btoa(String.fromCharCode(...raw));
}

const ALL_STATES: TransferState["kind"][] = [
  "queued",
  "sending",
  "checking",
  "uploaded",
  "downloaded",
  "failed",
];

describe("state machine transition table", () => {
  test("valid transitions per PLAN.md", () => {
    expect(STATE_TRANSITIONS.queued).toEqual(["sending", "failed"]);
    expect(STATE_TRANSITIONS.sending).toEqual(["sending", "checking", "failed"]);
    expect(STATE_TRANSITIONS.checking).toEqual([
      "uploaded",
      "downloaded",
      "failed",
    ]);
    expect(STATE_TRANSITIONS.uploaded).toEqual([]);
    expect(STATE_TRANSITIONS.downloaded).toEqual([]);
    expect(STATE_TRANSITIONS.failed).toEqual(["queued"]);
  });

  test("uploaded is terminal — no transition out is valid", () => {
    for (const kind of ALL_STATES) {
      expect(canTransition({ kind: "uploaded" }, stateOf(kind))).toBe(false);
    }
  });

  test("downloaded is terminal — no transition out is valid", () => {
    for (const kind of ALL_STATES) {
      expect(canTransition({ kind: "downloaded" }, stateOf(kind))).toBe(false);
    }
  });

  test("cannot jump straight from queued to uploaded or checking", () => {
    expect(canTransition({ kind: "queued" }, { kind: "uploaded" })).toBe(false);
    expect(canTransition({ kind: "queued" }, { kind: "checking" })).toBe(false);
  });

  test("sending and checking can no longer re-queue (no auto-retry)", () => {
    expect(canTransition({ kind: "sending", percent: 40 }, { kind: "queued" })).toBe(false);
    expect(canTransition({ kind: "checking" }, { kind: "queued" })).toBe(false);
  });

  test("failed only ever transitions back to queued (retry)", () => {
    expect(canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "queued" })).toBe(
      true,
    );
    expect(
      canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "uploaded" }),
    ).toBe(false);
    expect(
      canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "sending", percent: 0 }),
    ).toBe(false);
  });

  function stateOf(kind: TransferState["kind"]): TransferState {
    switch (kind) {
      case "sending":
        return { kind: "sending", percent: 0 };
      case "failed":
        return { kind: "failed", errorClass: "unknown" };
      default:
        return { kind } as TransferState;
    }
  }
});

describe("TransferEngine — single-part upload", () => {
  test("queued -> sending -> checking -> uploaded, persisted at every step", async () => {
    const body = new TextEncoder().encode("small file");
    const reader = makeReader({ "/local/a.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ChecksumCRC32: await crc32Base64(body) });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueue([
      { localPath: "/local/a.txt", size: body.length, key: "a.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    const finalTransfer = engine.getTransfer(transfer.id)!;
    expect(finalTransfer.state).toEqual({ kind: "uploaded" });

    const persisted = await store.get(transfer.id);
    expect(persisted?.state).toEqual({ kind: "uploaded" });

    const seenKinds = events
      .filter((e) => e.type === "transfer-updated")
      .map((e) => (e as { transfer: Transfer }).transfer.state.kind);
    expect(seenKinds[0]).toBe("queued");
    expect(seenKinds).toContain("sending");
    expect(seenKinds).toContain("checking");
    expect(seenKinds[seenKinds.length - 1]).toBe("uploaded");

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 0, failed: 0 });
  });

  test("ChecksumCRC32 mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("mismatched");
    const reader = makeReader({ "/local/b.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ChecksumCRC32: "AAAAAA==" });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/b.txt", size: body.length, key: "b.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    const finalTransfer = engine.getTransfer(transfer.id)!;
    expect(finalTransfer.state).toEqual({ kind: "failed", errorClass: "verification" });

    // Never uploaded.
    expect(finalTransfer.state.kind).not.toBe("uploaded");
  });

  test("credentials error (403) maps through to errorClass credentials", async () => {
    const body = new TextEncoder().encode("x");
    const reader = makeReader({ "/local/c.txt": body });
    s3Mock.on(PutObjectCommand).rejects({
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/c.txt", size: body.length, key: "c.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");
    expect(engine.getTransfer(transfer.id)!.state).toEqual({
      kind: "failed",
      errorClass: "credentials",
    });
  });

  });

describe("TransferEngine — concurrency and batching", () => {
  test("processes an enqueued batch and emits one batch-finished with correct counts", async () => {
    const files: Record<string, Uint8Array> = {};
    const specs = [1, 2, 3, 4, 5].map((n) => {
      const path = `/local/f${n}.txt`;
      const body = new TextEncoder().encode(`file-${n}`);
      files[path] = body;
      return { localPath: path, size: body.length, key: `f${n}.txt` };
    });
    const reader = makeReader(files);

    async function bodyToBytes(body: unknown): Promise<Uint8Array> {
      if (body instanceof Uint8Array) return body;
      if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
      return new Uint8Array(0);
    }
    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      const body = await bodyToBytes(input.Body);
      return { ChecksumCRC32: await crc32Base64(body) };
    });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      concurrency: 3,
    });
    engine.subscribe((e) => events.push(e));

    const transfers = await engine.enqueue(specs);
    await waitUntil(() =>
      transfers.every((t) => engine.getTransfer(t.id)?.state.kind === "uploaded"),
    );

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 5, downloaded: 0, failed: 0 });
  });
});

describe("TransferEngine — resumePending", () => {
  test("non-terminal transfers are marked as failed, not auto-resumed", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const sendingTransfer: Transfer = {
      id: "stuck-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      direction: "upload",
      state: { kind: "sending", percent: 33 },
      createdAt: now,
      updatedAt: now,
    };
    const queuedTransfer: Transfer = {
      id: "stuck-2",
      connectionId: "conn-1",
      key: "other.bin",
      localPath: "/local/other.bin",
      size: 50,
      direction: "upload",
      state: { kind: "queued" },
      createdAt: now,
      updatedAt: now,
    };
    const doneTransfer: Transfer = {
      id: "done-1",
      connectionId: "conn-1",
      key: "done.bin",
      localPath: "/local/done.bin",
      size: 10,
      direction: "upload",
      state: { kind: "uploaded" },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(sendingTransfer);
    await store.save(queuedTransfer);
    await store.save(doneTransfer);

    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      store,
    });

    await engine.resumePending();

    // Non-terminal transfers are now failed.
    const s1 = engine.getTransfer("stuck-1");
    expect(s1?.state.kind).toBe("failed");
    const s2 = engine.getTransfer("stuck-2");
    expect(s2?.state.kind).toBe("failed");

    // Terminal transfers keep their state.
    const d = engine.getTransfer("done-1");
    expect(d?.state.kind).toBe("uploaded");

    // Also persisted to store.
    expect((await store.get("stuck-1"))?.state.kind).toBe("failed");
    expect((await store.get("stuck-2"))?.state.kind).toBe("failed");

    // Nothing was re-queued — engine.queue is empty.
    expect(engine["queue"]).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
