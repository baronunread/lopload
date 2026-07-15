import { describe, expect, test, beforeAll } from "bun:test";
import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TransferEngine } from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { LocalFileWriter } from "../../src/lib/s3/download";
import type { EngineEvent, Transfer } from "../../src/lib/types";
import { DEFAULT_TUNING } from "../../src/lib/tuning";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/storage";
import { bucketProbe } from "../support/bucketProbe";
import { faultyFetch } from "../support/faultyFetch";
import { localFileReader, localFileWriter } from "../support/localFiles";
import { nativeFetch } from "../setup";

let bucket: Bucket;
let workdir: string;

beforeAll(async () => {
  bucket = await freshBucket();
  workdir = await mkdtemp(join(tmpdir(), "lopload-engine-download-test-"));
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Wraps a FetchFn so requests matching `match` hang until the request's own
 * AbortSignal fires, then reject the way a real aborted fetch does. This is
 * the real-storage equivalent of the old mock's "hang, then reject on
 * abort" pattern — there's no `Fault` for it (faultyFetch's faults either
 * complete or fail immediately), so it lives here rather than in
 * tests/support. `onStart` fires when a matching request begins, so tests
 * can wait for the real request to actually be in flight before cancelling. */
function hangUntilAborted(
  inner: FetchFn,
  match: (url: string, method: string) => boolean,
  onStart?: () => void,
): FetchFn {
  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!match(url, method)) return inner(input, init);
    onStart?.();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        const err = new Error("Request aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (!signal) return; // no signal on this request: hangs for the test's duration
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort);
    });
  };
}

/** Wraps the real localFileWriter, recording every discard() call — so
 * cancel/dismiss cleanup can be asserted on without a fake in-memory writer. */
function instrumentedWriter(): { writer: LocalFileWriter; discarded: string[] } {
  const discarded: string[] = [];
  const writer: LocalFileWriter = {
    ...localFileWriter,
    async discard(tempPath) {
      discarded.push(tempPath);
      await localFileWriter.discard(tempPath);
    },
  };
  return { writer, discarded };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("TransferEngine — download state machine", () => {
  test("queued -> sending -> checking -> downloaded, verified and committed", async () => {
    const body = new TextEncoder().encode("remote file contents");
    await bucketProbe(bucket.client, bucket.name).put("remote/a.txt", body);

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer: localFileWriter,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const localPath = join(workdir, "a.txt");
    const [transfer] = await engine.enqueueDownloads([
      { key: "remote/a.txt", localPath, size: body.length },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "downloaded");

    expect(new Uint8Array(await Bun.file(localPath).arrayBuffer())).toEqual(body);
    const persisted = await store.get(transfer.id);
    expect(persisted?.state).toEqual({ kind: "downloaded" });
    expect(persisted?.direction).toBe("download");

    const seenKinds = events
      .filter((e) => e.type === "transfer-updated")
      .map((e) => (e as { transfer: { state: { kind: string } } }).transfer.state.kind);
    expect(seenKinds[0]).toBe("queued");
    expect(seenKinds).toContain("sending");
    expect(seenKinds).toContain("checking");
    expect(seenKinds[seenKinds.length - 1]).toBe("downloaded");

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 0, downloaded: 1, failed: 0 });
  });

  test("checksum mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("remote file contents");
    await bucketProbe(bucket.client, bucket.name).put("remote/b.txt", body);
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "remote/b.txt", method: "GET", action: { kind: "corruptEtag" } },
      ]),
    );

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer: localFileWriter,
      store,
    });

    const localPath = join(workdir, "b.txt");
    const [transfer] = await engine.enqueueDownloads([
      { key: "remote/b.txt", localPath, size: body.length },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");
    expect(engine.getTransfer(transfer.id)!.state).toEqual({
      kind: "failed",
      errorClass: "verification",
    });
    expect(await fileExists(localPath)).toBe(false);
  });

  test("mixed upload+download batch reports both counts on batch-finished", async () => {
    const uploadBody = new TextEncoder().encode("upload me");
    await Bun.write(join(workdir, "up.txt"), uploadBody);
    const downloadBody = new TextEncoder().encode("download me");
    await bucketProbe(bucket.client, bucket.name).put("down.txt", downloadBody);

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer: localFileWriter,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [upTransfer] = await engine.enqueue([
      { localPath: join(workdir, "up.txt"), size: uploadBody.length, key: "up.txt" },
    ]);
    const [downTransfer] = await engine.enqueueDownloads([
      { key: "down.txt", localPath: join(workdir, "down.txt"), size: downloadBody.length },
    ]);

    await waitUntil(
      () =>
        engine.getTransfer(upTransfer.id)?.state.kind === "uploaded" &&
        engine.getTransfer(downTransfer.id)?.state.kind === "downloaded",
    );

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 1, failed: 0 });
  });
});

describe("TransferEngine — cancel", () => {
  test("cancelling a queued (not-yet-started) transfer drops it without ever running it", async () => {
    // Concurrency 1 + a first upload that hangs forever keeps the second
    // transfer sitting in "queued" so cancel() can target it deterministically.
    const client = clientWith(hangUntilAborted(nativeFetch, (_url, m) => m === "PUT"));
    await Bun.write(join(workdir, "1.txt"), new Uint8Array([1]));
    await Bun.write(join(workdir, "2.txt"), new Uint8Array([2]));

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 1 }),
    });

    const [first, second] = await engine.enqueue([
      { localPath: join(workdir, "1.txt"), size: 1, key: "1.txt" },
      { localPath: join(workdir, "2.txt"), size: 1, key: "2.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(first.id)?.state.kind === "sending");
    expect(engine.getTransfer(second.id)?.state.kind).toBe("queued");

    await engine.cancel(second.id);

    expect(engine.getTransfer(second.id)).toBeUndefined();
    const persisted = await store.get(second.id);
    expect(persisted).toBeNull();
  });

  test("cancelling an in-flight upload aborts it, drops it from the engine, and never persists a failed state", async () => {
    let started = 0;
    const client = clientWith(
      hangUntilAborted(
        nativeFetch,
        (url, m) => m === "PUT" && url.includes("slow.txt"),
        () => started++,
      ),
    );
    await Bun.write(join(workdir, "slow.txt"), new Uint8Array([1, 2, 3]));

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueue([
      { localPath: join(workdir, "slow.txt"), size: 3, key: "slow.txt" },
    ]);
    // "Sending" state now lands before the PUT is actually issued (hash
    // setup is async) — wait for the real request itself so the cancel
    // really aborts an in-flight upload.
    await waitUntil(() => started > 0);

    await engine.cancel(transfer.id);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();

    // Give the real, now-aborted fetch a moment to actually reject.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Still gone — never resurrected into a sticky "failed" transfer.
    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.some((e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed")).toBe(
      false,
    );

    // The store record is deleted along with the transfer.
    const persisted = await store.get(transfer.id);
    expect(persisted).toBeNull();
  });

  test("cancelling an in-flight download discards its temp file and never persists a failed state", async () => {
    let started = 0;
    await bucketProbe(bucket.client, bucket.name).put("slow.bin", new Uint8Array(100));
    const client = clientWith(
      hangUntilAborted(
        nativeFetch,
        (url, m) => m === "GET" && url.includes("slow.bin"),
        () => started++,
      ),
    );

    const store = new MemoryTransferStore();
    const { writer, discarded } = instrumentedWriter();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const localPath = join(workdir, "slow.bin");
    const [transfer] = await engine.enqueueDownloads([
      { key: "slow.bin", localPath, size: 100 },
    ]);
    await waitUntil(() => started > 0);

    await engine.cancel(transfer.id);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();

    await waitUntil(() => discarded.length > 0);

    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.some((e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed")).toBe(
      false,
    );
    // Cancelling always asks the writer to clean up, even here where the
    // GET was still hanging when cancelled: the engine can't tell how far
    // the download got, and cancelling deletes the transfer's row (and with
    // it the part rows resume needs), so anything already on disk is
    // unresumable litter. discard() is best-effort and no-ops on a file that
    // was never created.
    expect(discarded).toEqual([writer.tempPathFor(localPath)]);

    const persisted = await store.get(transfer.id);
    expect(persisted).toBeNull();
  });
});

/**
 * A download's temp file is resume state for as long as the transfer's row
 * survives: a ranged download deliberately keeps both on failure so a retry
 * can pick up from the bytes already on disk. The moment the row is deleted,
 * though, the part rows go with it and nothing can ever resume from that file
 * again — so every path that deletes the row has to take the temp file too,
 * or downloads quietly pile up litter next to the user's files.
 */
describe("TransferEngine — download temp-file cleanup", () => {
  const MiB = 1024 * 1024;

  test("cancelling a ranged download removes the temp file it was resuming from", async () => {
    // Big enough (and enough connections, per DEFAULT_TUNING) to take the
    // ranged path — the one that keeps its temp file on abort.
    const body = new Uint8Array(32 * MiB);
    await bucketProbe(bucket.client, bucket.name).put("big.bin", body);

    let started = 0;
    const client = clientWith(
      hangUntilAborted(
        nativeFetch,
        (url, m) => m === "GET" && url.includes("big.bin"),
        () => started++,
      ),
    );

    const store = new MemoryTransferStore();
    const { writer, discarded } = instrumentedWriter();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer,
      store,
    });

    const localPath = join(workdir, "big.bin");
    const [transfer] = await engine.enqueueDownloads([
      { key: "big.bin", localPath, size: body.length },
    ]);

    // Wait for all four range workers (DEFAULT_TUNING.downloadConnections)
    // to actually have their GET in flight before cancelling, so the abort
    // really tears down in-flight requests rather than racing workers that
    // hadn't started yet.
    await waitUntil(() => started === DEFAULT_TUNING.downloadConnections);

    await engine.cancel(transfer.id);

    await waitUntil(() => discarded.includes(writer.tempPathFor(localPath)));
    expect(await store.get(transfer.id)).toBeNull();
  });

  test("dismissing a failed download removes the temp file it kept for a retry", async () => {
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "gone.bin", method: "GET", action: { kind: "networkError", message: "network went away" } },
      ]),
    );

    const store = new MemoryTransferStore();
    const { writer, discarded } = instrumentedWriter();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer,
      store,
    });

    const localPath = join(workdir, "gone.bin");
    const [transfer] = await engine.enqueueDownloads([
      { key: "gone.bin", localPath, size: 100 },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    // Failing on its own keeps the transfer around — the user can still retry
    // it, so its bytes on disk are still worth something.
    expect(discarded).toEqual([]);

    await engine.dismiss(transfer.id);

    // Dismissing is the user saying they're done with it. The row goes, so the
    // bytes can never be resumed from and have to go too.
    expect(discarded).toEqual([writer.tempPathFor(localPath)]);
    expect(await store.get(transfer.id)).toBeNull();
  });

  test("a download interrupted by the app quitting doesn't leave its temp file behind", async () => {
    const store = new MemoryTransferStore();
    const { writer, discarded } = instrumentedWriter();
    const localPath = join(workdir, "quit.bin");

    // A row still marked "sending" in the store is what a download that was
    // running when the app quit looks like on the next launch.
    await store.save({
      id: "t-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath,
      size: 32 * MiB,
      partSize: 8 * MiB,
      direction: "download",
      state: { kind: "sending", percent: 42 },
      createdAt: 1,
      updatedAt: 1,
    });

    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer,
      store,
    });
    await engine.resumePending();

    // Downloads aren't picked back up across launches: the row is dropped,
    // which drops the part rows resume would need — so the half-written file
    // is dead weight rather than something to resume from.
    expect(await store.get("t-1")).toBeNull();
    expect(discarded).toEqual([writer.tempPathFor(localPath)]);
  });

  test("leaves an upload's row alone — only downloads stage into a temp file", async () => {
    const store = new MemoryTransferStore();
    const { writer, discarded } = instrumentedWriter();
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer,
      store,
    });

    await store.save({
      id: "u-1",
      connectionId: "conn-1",
      key: "up.bin",
      localPath: join(workdir, "up.bin"),
      size: 10,
      partSize: 8 * MiB,
      direction: "upload",
      state: { kind: "failed", errorClass: "connection-dropped" },
      createdAt: 1,
      updatedAt: 1,
    });
    await engine.resumePending();
    await engine.dismiss("u-1");

    // An upload reads from the user's own file — there's no temp file to
    // remove, and reaching for one would mean deleting the source.
    expect(discarded).toEqual([]);
  });
});
