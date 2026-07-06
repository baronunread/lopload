// Download engine, mirroring multipart.ts's guarantees: streamed to a temp
// file (never held whole in memory), verified before the file is considered
// real, and renamed into place only after verification passes.
//
// Unlike uploads, a failed/cancelled download simply restarts from byte zero
// on retry rather than resuming mid-file — GetObject has no equivalent to
// multipart's persisted per-part ETags to reconcile against.

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { Transfer } from "../types";
import { Md5, bytesToHex } from "../md5";
import { VerificationError } from "./multipart";

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
}

export interface DownloadDeps {
  client: S3Client;
  bucket: string;
  writer: LocalFileWriter;
  /** Called after each chunk of bytes is confirmed written, for progress UI. */
  onProgress?: (bytesReceived: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

/** A composite (multipart) ETag looks like "<hex>-<partCount>" — only a
 * plain single-part ETag is a bare 32-hex-char MD5 we can verify against. */
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
 * ReadableStream or Uint8Array directly. */
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
  const { client, bucket, writer, onProgress, signal } = deps;
  const tempPath = writer.tempPathFor(transfer.localPath);

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
    await writer.discard(tempPath);
    throw new VerificationError(
      "The downloaded file's size didn't match what was expected.",
    );
  }
  if (hasher) {
    const localHex = bytesToHex(hasher.digest());
    if (localHex.toLowerCase() !== etag.toLowerCase()) {
      await writer.discard(tempPath);
      throw new VerificationError(
        "The downloaded file's checksum didn't match what was expected.",
      );
    }
  }

  await writer.commit(tempPath, transfer.localPath);
}
