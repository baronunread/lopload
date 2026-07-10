// Download engine: streamed to a temp file (never held whole in memory),
// verified before the file is considered real, and renamed into place only
// after verification passes.
//
// Files at or above MULTIPART_THRESHOLD download over parallel ranged GETs
// when more than one connection is allowed; completed ranges are persisted
// (TransferStore parts with etag "") so a failed/cancelled download resumes
// from the ranges already on disk. Smaller files (or connections: 1) use a
// single streamed GetObject that restarts from byte zero on failure.

import {
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import type { Transfer, TransferPart, TransferStore } from "../types";
import { Md5, bytesToHex } from "../md5";
import {
  MULTIPART_THRESHOLD,
  VerificationError,
  type LocalFileReader,
} from "./multipart";
import { createLogger } from "../logger";

const log = createLogger("download");

/**
 * Injected local-file writer. Production impl (src/tauri/fs.ts) writes
 * sequentially to a temp sibling of the destination path via
 * @tauri-apps/plugin-fs, then renames it into place — the destination path
 * never exists in a partially-written state.
 */
export interface LocalFileWriter {
  /** Temp path to write to for this destination; a sibling of `finalPath`. */
  tempPathFor(finalPath: string): string;
  /** Writes one chunk in order. `isFirst` truncates/creates; later calls append. */
  writeChunk(tempPath: string, chunk: Uint8Array, isFirst: boolean): Promise<void>;
  /** Renames the verified temp file into place, replacing anything already there. */
  commit(tempPath: string, finalPath: string): Promise<void>;
  /** Best-effort cleanup of a temp file after a failed/cancelled download. */
  discard(tempPath: string): Promise<void>;
  /** Creates (or truncates) the temp file to exactly `size` bytes, so ranged
   * workers can writeAt() anywhere inside it. */
  allocate(tempPath: string, size: number): Promise<void>;
  /** Writes one chunk at an absolute offset. Must be safe under concurrent
   * calls targeting non-overlapping offsets. */
  writeAt(tempPath: string, offset: number, chunk: Uint8Array): Promise<void>;
  /** Current size of the temp file, or null if it doesn't exist. */
  sizeOf(tempPath: string): Promise<number | null>;
}

export interface DownloadDeps {
  client: S3Client;
  bucket: string;
  writer: LocalFileWriter;
  /** Reads the temp file back for post-download checksum verification. */
  reader: LocalFileReader;
  /** Persists completed ranges (as parts with etag "") for resume. */
  store: TransferStore;
  /** Max parallel ranged GETs. 1 (default) forces the streaming path. */
  connections?: number;
  /** Called after each chunk of bytes is confirmed written, for progress UI. */
  onProgress?: (bytesReceived: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

/** A plain single-part ETag is a bare 32-hex-char MD5 we can verify against. */
const PLAIN_MD5_ETAG = /^[0-9a-f]{32}$/i;

interface TransformableBody {
  transformToWebStream(): ReadableStream<Uint8Array>;
}

function hasTransformToWebStream(body: unknown): body is TransformableBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
  );
}

/** Normalizes a GetObject response body into a ReadableStream — the real SDK
 * response exposes `.transformToWebStream()`; tests may hand back a plain
 * ReadableStream or Uint8Array directly. The Tauri HTTP plugin may return a
 * Blob when the response body isn't available as a stream. */
function bodyToWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (hasTransformToWebStream(body)) return body.transformToWebStream();
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (body instanceof Uint8Array) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }
  if (body instanceof Blob) {
    return body.stream();
  }
  throw new Error("GetObject response body has no readable stream");
}

/**
 * Download one transfer to completion, verifying integrity before returning.
 * Resolves on verified success; rejects with VerificationError on integrity
 * mismatch, or the raw SDK/network error otherwise (callers classify via
 * `errors.ts`). Never resolves on an unverified download, and never leaves a
 * partial file at the destination path.
 */
export async function downloadTransfer(
  transfer: Transfer,
  deps: DownloadDeps,
): Promise<void> {
  const connections = deps.connections ?? 1;
  if (transfer.size >= MULTIPART_THRESHOLD && connections > 1) {
    return downloadRanged(transfer, deps, connections);
  }
  return downloadStreamed(transfer, deps);
}

/** Single streamed GetObject — small files, or a single allowed connection.
 * Restarts from byte zero on failure. */
async function downloadStreamed(
  transfer: Transfer,
  deps: DownloadDeps,
): Promise<void> {
  const { client, bucket, writer, onProgress, signal } = deps;
  const tempPath = writer.tempPathFor(transfer.localPath);

  log.debug("starting download", transfer.key);

  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: transfer.key }),
    { abortSignal: signal },
  );
  if (!res.Body) {
    throw new Error("GetObject did not return a body");
  }

  const etag = stripQuotes(res.ETag ?? "");
  const hasher = PLAIN_MD5_ETAG.test(etag) ? await Md5.create() : null;
  const expectedSize = res.ContentLength ?? transfer.size;

  const stream = bodyToWebStream(res.Body);
  const reader = stream.getReader();
  let received = 0;
  let wroteAnything = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        await writer.writeChunk(tempPath, value, !wroteAnything);
        wroteAnything = true;
        hasher?.update(value);
        received += value.length;
        onProgress?.(received, expectedSize || received);
      }
    }
    if (!wroteAnything) {
      // Zero-byte file — still materialize an (empty) temp file so commit()
      // has something to rename into place.
      await writer.writeChunk(tempPath, new Uint8Array(0), true);
    }
  } catch (err) {
    await writer.discard(tempPath);
    throw err;
  }

  if (received !== expectedSize) {
    log.warn("size mismatch", transfer.key, { received, expectedSize });
    await writer.discard(tempPath);
    throw new VerificationError(
      "The downloaded file's size didn't match what was expected.",
    );
  }
  if (hasher) {
    const localHex = bytesToHex(hasher.digest());
    if (localHex.toLowerCase() !== etag.toLowerCase()) {
      log.warn("checksum mismatch", transfer.key, { localHex, etag });
      await writer.discard(tempPath);
      throw new VerificationError(
        "The downloaded file's checksum didn't match what was expected.",
      );
    }
  }

  log.debug("download complete", transfer.key, { received, etag });
  await writer.commit(tempPath, transfer.localPath);
}

/** Read-back chunk size for post-download MD5 verification. */
const VERIFY_CHUNK_SIZE = 4 * 1024 * 1024;

/** Ranged workers coalesce stream chunks (~64 KiB each from the SDK) into a
 * buffer of roughly this size before issuing a single `writeAt`, so a part
 * (up to `transfer.partSize`, typically 8 MiB) costs a handful of writes
 * instead of one per chunk. Kept well under partSize so large parts still
 * flush incrementally rather than buffering the whole part in memory. */
const WRITE_BUFFER_WINDOW = 2 * 1024 * 1024;

/**
 * Parallel ranged download with resume. The object is split into
 * `transfer.partSize` ranges numbered 1..N (mirroring upload part numbers); a
 * pool of `connections` workers GETs them with Range headers and writes each
 * chunk at its absolute offset in a pre-allocated temp file. Completed ranges
 * are persisted as parts with etag "" so a later attempt skips them.
 *
 * On network error/abort the temp file and part rows are deliberately KEPT —
 * they are the resume state. The temp file is only discarded when
 * verification fails (the bytes on disk are wrong, so resuming from them
 * would be wrong too); stale part rows are then invalidated by the temp-file
 * size check on the next attempt and re-saved over (the store only clears
 * part rows when the whole transfer is deleted).
 */
async function downloadRanged(
  transfer: Transfer,
  deps: DownloadDeps,
  connections: number,
): Promise<void> {
  const { client, bucket, writer, reader, store, onProgress, signal } = deps;
  const tempPath = writer.tempPathFor(transfer.localPath);

  // Ranged GET responses report the range's own Content-Length, so the
  // object's authoritative size (and ETag) must come from a HEAD first.
  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: transfer.key }),
    { abortSignal: signal },
  );
  const totalSize = head.ContentLength ?? transfer.size;
  const etag = stripQuotes(head.ETag ?? "");
  const partSize = transfer.partSize;
  const totalParts = Math.ceil(totalSize / partSize);
  const lengthOf = (partNumber: number): number =>
    Math.min(partSize, totalSize - (partNumber - 1) * partSize);

  log.debug("starting ranged download", transfer.key, {
    totalSize,
    totalParts,
    partSize,
    connections,
  });

  // Resume: persisted ranges only count if the temp file still exists at the
  // expected size — otherwise the rows describe a file we no longer have.
  const completed = new Set<number>();
  const existingSize = await writer.sizeOf(tempPath);
  if (existingSize === totalSize) {
    for (const p of await store.listParts(transfer.id)) {
      if (p.partNumber >= 1 && p.partNumber <= totalParts && p.size === lengthOf(p.partNumber)) {
        completed.add(p.partNumber);
      }
    }
    if (completed.size > 0) {
      log.debug("resuming ranged download", transfer.key, { completedRanges: completed.size });
    }
  } else {
    await writer.allocate(tempPath, totalSize);
  }

  let received = 0;
  for (const partNumber of completed) received += lengthOf(partNumber);
  onProgress?.(received, totalSize);

  // Worker pool. The local controller fans a single failure (or the outer
  // abort) out to every sibling connection.
  const local = new AbortController();
  const onOuterAbort = () => local.abort();
  if (signal?.aborted) local.abort();
  signal?.addEventListener("abort", onOuterAbort);

  let failed = false;
  let firstError: unknown;
  let nextPart = 1;

  const worker = async (): Promise<void> => {
    while (!local.signal.aborted) {
      const partNumber = nextPart++;
      if (partNumber > totalParts) return;
      if (completed.has(partNumber)) continue;

      const start = (partNumber - 1) * partSize;
      const end = start + lengthOf(partNumber) - 1;
      const res = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: transfer.key,
          Range: `bytes=${start}-${end}`,
        }),
        { abortSignal: local.signal },
      );
      if (!res.Body) {
        throw new Error("GetObject did not return a body");
      }

      const streamReader = bodyToWebStream(res.Body).getReader();
      let written = 0;

      // Coalesce small stream chunks into a single buffer and flush with one
      // writeAt() per window, instead of one writeAt() per (~64 KiB) chunk.
      // Progress accounting stays per-chunk below so UI granularity/speed
      // tracking is unaffected by the buffering.
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let pendingOffset = start + written;

      const flush = async (): Promise<void> => {
        if (pendingBytes === 0) return;
        const buffer = new Uint8Array(pendingBytes);
        let pos = 0;
        for (const chunk of pending) {
          buffer.set(chunk, pos);
          pos += chunk.length;
        }
        await writer.writeAt(tempPath, pendingOffset, buffer);
        pending = [];
        pendingBytes = 0;
        pendingOffset = start + written;
      };

      while (true) {
        const { value, done } = await streamReader.read();
        if (done) break;
        if (value && value.length > 0) {
          pending.push(value);
          pendingBytes += value.length;
          written += value.length;
          received += value.length;
          onProgress?.(received, totalSize);
          if (pendingBytes >= WRITE_BUFFER_WINDOW) {
            await flush();
          }
        }
      }
      // Flush any remainder BEFORE marking the part complete — saveParts
      // must never record a part whose bytes aren't fully on disk yet, or
      // resume would skip re-fetching data that was never actually written.
      await flush();

      const part: TransferPart = {
        transferId: transfer.id,
        partNumber,
        etag: "",
        size: end - start + 1,
      };
      await store.saveParts([part]);
    }
  };

  const poolSize = Math.max(1, Math.min(connections, totalParts));
  try {
    await Promise.all(
      Array.from({ length: poolSize }, () =>
        worker().catch((err) => {
          if (!failed) {
            failed = true;
            firstError = err;
          }
          local.abort();
        }),
      ),
    );
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }

  if (failed || signal?.aborted) {
    // Keep the temp file and part rows — they are the resume state.
    if (signal?.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof Error) throw reason;
      const abortErr = new Error("Request aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw firstError;
  }

  const finalSize = await writer.sizeOf(tempPath);
  if (finalSize !== totalSize) {
    log.warn("size mismatch", transfer.key, { finalSize, totalSize });
    await writer.discard(tempPath);
    throw new VerificationError(
      "The downloaded file's size didn't match what was expected.",
    );
  }

  if (PLAIN_MD5_ETAG.test(etag)) {
    // Ranges land out of order, so the hash can't be built while streaming —
    // re-read the finished temp file sequentially instead.
    const hasher = await Md5.create();
    for (let offset = 0; offset < totalSize; offset += VERIFY_CHUNK_SIZE) {
      const length = Math.min(VERIFY_CHUNK_SIZE, totalSize - offset);
      hasher.update(await reader.readChunk(tempPath, offset, length));
    }
    const localHex = bytesToHex(hasher.digest());
    if (localHex.toLowerCase() !== etag.toLowerCase()) {
      log.warn("checksum mismatch", transfer.key, { localHex, etag });
      await writer.discard(tempPath);
      throw new VerificationError(
        "The downloaded file's checksum didn't match what was expected.",
      );
    }
  }

  log.debug("ranged download complete", transfer.key, { received, etag });
  await writer.commit(tempPath, transfer.localPath);
}
