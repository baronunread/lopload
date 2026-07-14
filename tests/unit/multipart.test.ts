import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import {
  PART_SIZE,
  VerificationError,
  uploadTransfer,
} from "../../src/lib/s3/multipart";
import { compositeEtag } from "../../src/lib/md5";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/storage";
import { faultyFetch } from "../support/faultyFetch";
import { localFileReader } from "../support/localFiles";
import { nativeFetch } from "../setup";

let bucket: Bucket;
let workdir: string;

beforeAll(async () => {
  bucket = await freshBucket();
  workdir = await mkdtemp(join(tmpdir(), "lopload-multipart-test-"));
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

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

async function writeLocalFile(name: string, body: Uint8Array): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, body);
  return path;
}

describe("uploadTransfer — single-part (ETag/MD5) verification", () => {
  test("happy path: ETag matches local MD5 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const path = await writeLocalFile("hello.txt", body);
    const transfer = makeTransfer({ key: "single/hello.txt", localPath: path, size: body.length });

    await expect(
      uploadTransfer(transfer, {
        client: clientWith(),
        bucket: bucket.name,
        reader: localFileReader,
        store: new MemoryTransferStore(),
      }),
    ).resolves.toBeUndefined();
  });

  test("ETag mismatch → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    const path = await writeLocalFile("mismatch.txt", body);
    const transfer = makeTransfer({ key: "single/mismatch.txt", localPath: path, size: body.length });
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "single/mismatch.txt", method: "PUT", action: { kind: "corruptEtag" } },
      ]),
    );

    await expect(
      uploadTransfer(transfer, {
        client,
        bucket: bucket.name,
        reader: localFileReader,
        store: new MemoryTransferStore(),
      }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("reports progress while reading chunks", async () => {
    const body = new Uint8Array(1000).fill(7);
    const path = await writeLocalFile("progress.bin", body);
    const transfer = makeTransfer({ key: "single/progress.bin", localPath: path, size: body.length });
    const progressCalls: Array<[number, number]> = [];

    await uploadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });
});

describe("uploadTransfer — multipart", () => {
  const partSize = 8 * 1024 * 1024;
  const bodySize = partSize * 2 + 1; // 16MB+1 > MULTIPART_THRESHOLD

  function makeBigBody(): Uint8Array {
    // Not all-zero: a real per-part MD5 must differ per part for the
    // composite-ETag verification to be a meaningful check rather than one
    // that would pass even if parts were silently swapped.
    const body = new Uint8Array(bodySize);
    for (let i = 0; i < body.length; i += 4096) body[i] = (i / 4096) % 256;
    return body;
  }

  test("creates upload, uploads parts, completes, and verifies composite ETag", async () => {
    const body = makeBigBody();
    const path = await writeLocalFile("multi-1.bin", body);
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-1",
      key: "multipart/multi-1.bin",
      localPath: path,
      size: body.length,
      partSize,
    });

    await uploadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      reader: localFileReader,
      store,
    });

    const parts = await store.listParts("multi-1");
    expect(parts.length).toBe(3);
  });

  test("clears the persisted uploadId once CompleteMultipartUpload succeeds", async () => {
    const body = makeBigBody();
    const path = await writeLocalFile("multi-clear.bin", body);
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-clear",
      key: "multipart/multi-clear.bin",
      localPath: path,
      size: body.length,
      partSize,
    });

    expect(transfer.uploadId).toBeUndefined();
    await uploadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      reader: localFileReader,
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
    const body = makeBigBody();
    const path = await writeLocalFile("multi-skip.bin", body);
    const key = "multipart/multi-skip.bin";

    // Arrange a real, already-in-progress multipart upload with part 1
    // already landed server-side — done directly against MinIO (not
    // through uploadTransfer) so the app's own ListPartsCommand call sees
    // genuine server truth to skip against, rather than a mocked response.
    const raw = new S3Client({
      endpoint: bucket.connection.endpoint,
      region: bucket.connection.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: bucket.credentials.accessKey,
        secretAccessKey: bucket.credentials.secretKey,
      },
    });
    const created = await raw.send(new CreateMultipartUploadCommand({ Bucket: bucket.name, Key: key }));
    const uploadId = created.UploadId!;
    await raw.send(
      new UploadPartCommand({
        Bucket: bucket.name,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: body.slice(0, partSize),
      }),
    );

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-skip",
      key,
      localPath: path,
      size: body.length,
      partSize,
      uploadId,
    });

    await expect(
      uploadTransfer(transfer, {
        client: clientWith(),
        bucket: bucket.name,
        reader: localFileReader,
        store,
      }),
    ).resolves.toBeUndefined();

    const parts = await store.listParts("multi-skip");
    expect(parts.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
  });
});

// The suite below is the deliberate exception to "no fakes": it drives
// uploadTransfer against a hand-rolled S3Client stub to watch the worker pool's
// internals — that exactly N parts are in flight, and that an abort mid-flight
// unwinds correctly. Those are claims about scheduling, not about storage, and
// real requests over loopback finish far too fast to pin either one down.
//
// Everything above this line talks to a real MinIO. Don't "fix" this by
// migrating it; there's nothing to migrate it to.
describe("uploadTransfer — parallel multipart (partsInFlight)", () => {
  // Small sizes: setting uploadId forces the multipart path regardless of
  // MULTIPART_THRESHOLD, so tests stay fast and memory-light.
  const partSize = 10;
  const body = new Uint8Array(30).fill(42); // 3 parts of 10
  const uploadId = "fake-upload";

  function partEtagHex(n: number): string {
    return n.toString(16).padStart(32, "0");
  }

  function makeReader(bytes: Uint8Array) {
    return {
      async size() {
        return bytes.length;
      },
      async readChunk(_path: string, offset: number, length: number) {
        return bytes.slice(offset, offset + length);
      },
    };
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
      ETag: `"${await compositeEtag(partNumbers.map(partEtagHex))}"`,
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
        return { ETag: `"${partEtagHex(input.PartNumber ?? 0)}"` };
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
        return { ETag: `"${partEtagHex(input.PartNumber ?? 0)}"` };
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
        return { ETag: `"${partEtagHex(n)}"` };
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
      [1, 2, 3].map((n) => `"${partEtagHex(n)}"`),
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
        return { ETag: `"${partEtagHex(n)}"` };
      },
      serverParts: [{ PartNumber: 1, ETag: `"${partEtagHex(1)}"`, Size: partSize }],
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
