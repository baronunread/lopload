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
  PART_SIZE,
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "../../src/lib/s3/multipart";
import { md5Hex, bytesToHex, compositeEtag } from "../../src/lib/md5";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

function q(hex: string): string {
  return `"${hex}"`;
}

beforeEach(() => {
  s3Mock.reset();
});

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: "/local/file.bin",
    size: 10,
    partSize: PART_SIZE,
    direction: "upload",
    state: { kind: "sending", percent: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeReader(bytes: Uint8Array): LocalFileReader {
  return {
    async size() {
      return bytes.length;
    },
    async readChunk(_path, offset, length) {
      return bytes.slice(offset, offset + length);
    },
  };
}

describe("uploadTransfer — single-part (ETag/MD5) verification", () => {
  test("happy path: ETag matches local MD5 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    const expectedMd5 = await md5Hex(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(expectedMd5) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store: new MemoryTransferStore() }),
    ).resolves.toBeUndefined();
  });

  test("ETag mismatch → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q("f".repeat(32)) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store: new MemoryTransferStore() }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("reports progress while reading chunks", async () => {
    const body = new Uint8Array(1000).fill(7);
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(await md5Hex(body)) });

    const transfer = makeTransfer({ size: body.length });
    const progressCalls: Array<[number, number]> = [];

    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader,
      store: new MemoryTransferStore(),
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });
});

describe("uploadTransfer — multipart", () => {
  const partSize = 8 * 1024 * 1024;
  const body = new Uint8Array(partSize * 2 + 1).fill(42); // 16MB+1 > MULTIPART_THRESHOLD

  test("creates upload, uploads parts, completes, and verifies composite ETag", async () => {
    const partEtag = "d41d8cd98f00b204e9800998ecf8427e";
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-123" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q(partEtag) });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const composite = await compositeEtag([partEtag, partEtag, partEtag]);
    s3Mock.on(HeadObjectCommand).resolves({
      ETag: q(composite),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-1",
      size: body.length,
      partSize,
    });

    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader: makeReader(body),
      store,
    });

    const parts = await store.listParts("multi-1");
    expect(parts.length).toBe(3);
  });

  test("clears the persisted uploadId once CompleteMultipartUpload succeeds", async () => {
    const partEtag = "d41d8cd98f00b204e9800998ecf8427e";
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-789" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q(partEtag) });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const composite = await compositeEtag([partEtag, partEtag, partEtag]);
    s3Mock.on(HeadObjectCommand).resolves({
      ETag: q(composite),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-clear",
      size: body.length,
      partSize,
    });

    expect(transfer.uploadId).toBeUndefined();
    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader: makeReader(body),
      store,
    });

    // The uploadId set on CreateMultipartUpload must be cleared, both on
    // the in-memory transfer object the engine holds a reference to, and
    // in the store — otherwise a future resume would try to reuse an
    // already-completed (dead) uploadId.
    expect(transfer.uploadId).toBeUndefined();
    const persisted = await store.get("multi-clear");
    expect(persisted?.uploadId).toBeUndefined();
  });

  test("skips already-uploaded parts (server truth)", async () => {
    const serverEtag = "ab56b4d92b40713acc5af89985d4b786";
    const newEtag = "d41d8cd98f00b204e9800998ecf8427e";
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-456" });
    s3Mock.on(ListPartsCommand).resolves({
      Parts: [
        { PartNumber: 1, ETag: q(serverEtag), Size: partSize },
      ],
    });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q(newEtag) });
    const composite = await compositeEtag([serverEtag, newEtag, newEtag]);
    s3Mock.on(HeadObjectCommand).resolves({
      ETag: q(composite),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-skip",
      size: body.length,
      partSize,
    });

    await expect(
      uploadTransfer(transfer, {
        client,
        bucket: "b",
        reader: makeReader(body),
        store,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("uploadTransfer — parallel multipart (partsInFlight)", () => {
  // Small sizes: setting uploadId forces the multipart path regardless of
  // MULTIPART_THRESHOLD, so tests stay fast and memory-light.
  const partSize = 10;
  const body = new Uint8Array(30).fill(42); // 3 parts of 10
  const uploadId = "fake-upload";

  function partEtagHex(n: number): string {
    return n.toString(16).padStart(32, "0");
  }

  interface FakeSendOptions {
    abortSignal?: AbortSignal;
  }

  function makeFakeClient(handlers: {
    onUploadPart: (
      input: { PartNumber?: number },
      opts?: FakeSendOptions,
    ) => Promise<{ ETag?: string }>;
    serverParts?: { PartNumber: number; ETag: string; Size: number }[];
    onComplete?: (input: {
      MultipartUpload?: { Parts?: { PartNumber?: number; ETag?: string }[] };
    }) => void;
    head?: { ETag: string; ContentLength: number };
  }): S3Client {
    return {
      async send(command: unknown, opts?: FakeSendOptions): Promise<unknown> {
        if (command instanceof CreateMultipartUploadCommand) {
          return { UploadId: uploadId };
        }
        if (command instanceof ListPartsCommand) {
          return { Parts: handlers.serverParts ?? [] };
        }
        if (command instanceof UploadPartCommand) {
          return handlers.onUploadPart(command.input, opts);
        }
        if (command instanceof CompleteMultipartUploadCommand) {
          handlers.onComplete?.(command.input);
          return {};
        }
        if (command instanceof HeadObjectCommand) {
          if (!handlers.head) throw new Error("unexpected HeadObject");
          return handlers.head;
        }
        throw new Error("unexpected command");
      },
    } as unknown as S3Client;
  }

  async function headFor(partNumbers: number[]) {
    return {
      ETag: q(await compositeEtag(partNumbers.map(partEtagHex))),
      ContentLength: body.length,
    };
  }

  /** A promise that rejects when the request's abortSignal fires; never resolves. */
  function hangUntilAborted(opts?: FakeSendOptions): Promise<never> {
    return new Promise((_resolve, reject) => {
      const sig = opts?.abortSignal;
      if (sig?.aborted) return reject(sig.reason);
      sig?.addEventListener("abort", () => reject(sig.reason));
    });
  }

  test("uploads parts in parallel when partsInFlight > 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const allInFlight = new Promise<void>((r) => (release = r));

    const fake = makeFakeClient({
      onUploadPart: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 3) release();
        await allInFlight;
        inFlight -= 1;
        return { ETag: q(partEtagHex(input.PartNumber ?? 0)) };
      },
      head: await headFor([1, 2, 3]),
    });

    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await uploadTransfer(transfer, {
      client: fake,
      bucket: "b",
      reader: makeReader(body),
      store: new MemoryTransferStore(),
      partsInFlight: 3,
    });

    expect(maxInFlight).toBe(3);
  });

  test("partsInFlight: 1 keeps uploads sequential", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fake = makeFakeClient({
      onUploadPart: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { ETag: q(partEtagHex(input.PartNumber ?? 0)) };
      },
      head: await headFor([1, 2, 3]),
    });

    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await uploadTransfer(transfer, {
      client: fake,
      bucket: "b",
      reader: makeReader(body),
      store: new MemoryTransferStore(),
      partsInFlight: 1,
    });

    expect(maxInFlight).toBe(1);
  });

  test("CompleteMultipartUpload gets parts sorted by PartNumber despite out-of-order completion", async () => {
    // Part 1 finishes last, part 3 first.
    const delays: Record<number, number> = { 1: 20, 2: 10, 3: 0 };
    const completedOrder: number[] = [];
    let completeParts: { PartNumber?: number; ETag?: string }[] | undefined;

    const fake = makeFakeClient({
      onUploadPart: async (input) => {
        const n = input.PartNumber ?? 0;
        await new Promise((r) => setTimeout(r, delays[n]));
        completedOrder.push(n);
        return { ETag: q(partEtagHex(n)) };
      },
      onComplete: (input) => {
        completeParts = input.MultipartUpload?.Parts;
      },
      head: await headFor([1, 2, 3]),
    });

    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await uploadTransfer(transfer, {
      client: fake,
      bucket: "b",
      reader: makeReader(body),
      store: new MemoryTransferStore(),
      partsInFlight: 3,
    });

    expect(completedOrder).toEqual([3, 2, 1]);
    expect(completeParts?.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(completeParts?.map((p) => p.ETag)).toEqual(
      [1, 2, 3].map((n) => q(partEtagHex(n))),
    );
    // headFor([1, 2, 3]) resolving also proves compositeEtag used sorted order.
  });

  test("one part failure aborts in-flight siblings and rejects with that error", async () => {
    const bang = new Error("part 1 exploded");
    const started: number[] = [];
    let part2Started!: () => void;
    const part2InFlight = new Promise<void>((r) => (part2Started = r));

    const fake = makeFakeClient({
      onUploadPart: (input, opts) => {
        const n = input.PartNumber ?? 0;
        started.push(n);
        if (n === 1) {
          // Fail only once part 2 is in flight, so the abort is observable.
          return part2InFlight.then(() => Promise.reject(bang));
        }
        part2Started();
        return hangUntilAborted(opts);
      },
    });

    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await expect(
      uploadTransfer(transfer, {
        client: fake,
        bucket: "b",
        reader: makeReader(body),
        store: new MemoryTransferStore(),
        partsInFlight: 2,
      }),
    ).rejects.toBe(bang);

    // Part 2 was aborted, and no worker went on to pull part 3.
    expect([...started].sort()).toEqual([1, 2]);
  });

  test("outer abort rejects with the abort reason, not a part error", async () => {
    const outer = new AbortController();
    const reason = new Error("cancelled by user");
    const started: number[] = [];

    const fake = makeFakeClient({
      onUploadPart: (input, opts) => {
        started.push(input.PartNumber ?? 0);
        if (started.length === 2) queueMicrotask(() => outer.abort(reason));
        return hangUntilAborted(opts);
      },
    });

    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await expect(
      uploadTransfer(transfer, {
        client: fake,
        bucket: "b",
        reader: makeReader(body),
        store: new MemoryTransferStore(),
        partsInFlight: 2,
        signal: outer.signal,
      }),
    ).rejects.toBe(reason);

    expect(started.length).toBe(2);
  });

  test("resume skips server-listed parts and seeds progress", async () => {
    const uploaded: number[] = [];
    const progress: Array<[number, number]> = [];

    const fake = makeFakeClient({
      onUploadPart: async (input) => {
        const n = input.PartNumber ?? 0;
        uploaded.push(n);
        return { ETag: q(partEtagHex(n)) };
      },
      serverParts: [{ PartNumber: 1, ETag: q(partEtagHex(1)), Size: partSize }],
      head: await headFor([1, 2, 3]),
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({ size: body.length, partSize, uploadId });
    await uploadTransfer(transfer, {
      client: fake,
      bucket: "b",
      reader: makeReader(body),
      store,
      onProgress: (sent, total) => progress.push([sent, total]),
      partsInFlight: 3,
    });

    expect([...uploaded].sort()).toEqual([2, 3]);
    expect(progress[0]).toEqual([partSize, body.length]);
    expect(progress[progress.length - 1]).toEqual([body.length, body.length]);
    const parts = await store.listParts(transfer.id);
    expect(parts.length).toBe(3);
  });
});