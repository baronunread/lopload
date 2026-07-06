import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import {
  STATE_TRANSITIONS,
  TransferEngine,
  canTransition,
} from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { md5Hex } from "../../src/lib/md5";
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

function q(hex: string): string {
  return `"${hex}"`;
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
    expect(STATE_TRANSITIONS.checking).toEqual(["uploaded", "downloaded", "failed", "sending"]);
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

  test("cannot jump straight from checking back to queued", () => {
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

describe("TransferEngine — single-part happy path", () => {
  test("queued -> sending -> checking -> uploaded, persisted at every step", async () => {
    const body = new TextEncoder().encode("small file");
    const reader = makeReader({ "/local/a.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(await md5Hex(body)) });

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

  test("ETag mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("mismatched");
    const reader = makeReader({ "/local/b.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ETag: q("f".repeat(32)) });

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

  test("retry resumes a failed transfer and can succeed the second time", async () => {
    const body = new TextEncoder().encode("retry me");
    const reader = makeReader({ "/local/d.txt": body });
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce({ name: "AccessDenied" })
      .resolves({ ETag: q(await md5Hex(body)) });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/d.txt", size: body.length, key: "d.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    await engine.retry(transfer.id);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    expect(engine.getTransfer(transfer.id)!.state).toEqual({ kind: "uploaded" });
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

    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      const body = input.Body as Uint8Array;
      return { ETag: q(await md5Hex(body)) };
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
  test("transfers left in sending/queued/checking reload and resume on startup", async () => {
    const size = 24 * 1024 * 1024; // multipart, 3 parts @ 8 MiB
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i % 251;
    const reader = makeReader({ "/local/big.bin": body });

    const PART_SIZE = 8 * 1024 * 1024;
    const partHexes: string[] = [];
    for (let i = 0; i < 3; i++) {
      partHexes.push(await md5Hex(body.slice(i * PART_SIZE, (i + 1) * PART_SIZE)));
    }

    const store = new MemoryTransferStore();
    const now = Date.now();
    const stuckTransfer: Transfer = {
      id: "stuck-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size,
      partSize: PART_SIZE,
      uploadId: "upload-stuck",
      direction: "upload",
      state: { kind: "sending", percent: 33 },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(stuckTransfer);
    await store.saveParts([
      { transferId: "stuck-1", partNumber: 1, etag: q(partHexes[0]), size: PART_SIZE },
    ]);

    s3Mock.on(ListPartsCommand).resolves({
      Parts: [{ PartNumber: 1, ETag: q(partHexes[0]), Size: PART_SIZE }],
    });
    s3Mock.on(UploadPartCommand).callsFake((input) => {
      const n = input.PartNumber as number;
      return Promise.resolve({ ETag: q(partHexes[n - 1]) });
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const { compositeEtag } = await import("../../src/lib/md5");
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: size,
      ETag: q(await compositeEtag(partHexes)),
    });

    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    await engine.resumePending();
    await waitUntil(() => engine.getTransfer("stuck-1")?.state.kind === "uploaded");

    // CreateMultipartUpload never called — the uploadId already existed.
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);
    // Only the missing parts (2, 3) got uploaded.
    const uploadCalls = s3Mock.commandCalls(UploadPartCommand);
    expect(uploadCalls.map((c) => c.args[0].input.PartNumber).sort()).toEqual([2, 3]);
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
