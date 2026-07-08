import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

import type { Transfer } from "../types";
import { Md5, bytesToHex } from "../md5";
import { createLogger } from "../logger";

const log = createLogger("upload");
const READ_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Injected local-file reader. Production impl (src/tauri/fs.ts) opens the
 * file once and seeks/reads chunks via @tauri-apps/plugin-fs — the whole
 * file is never loaded into memory for large uploads.
 */
export interface LocalFileReader {
  size(path: string): Promise<number>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
}

/** Thrown when post-upload verification fails; engine maps this to errorClass "verification". */
export class VerificationError extends Error {
  readonly errorClass = "verification" as const;
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export interface UploadDeps {
  client: S3Client;
  bucket: string;
  reader: LocalFileReader;
  /** Called after each chunk of bytes is confirmed sent, for progress UI. */
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, "");
}

function concatChunks(chunks: Uint8Array[], totalSize: number): Uint8Array {
  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Upload one transfer to completion, verifying integrity before returning.
 * Resolves on verified success; rejects with VerificationError on integrity
 * mismatch, or the raw SDK/network error otherwise (callers classify via
 * `errors.ts`). Never resolves on an unverified upload.
 */
export async function uploadTransfer(
  transfer: Transfer,
  deps: UploadDeps,
): Promise<void> {
  log.debug("starting upload", transfer.key, { size: transfer.size });
  const { client, bucket, reader, onProgress, signal } = deps;
  const size = transfer.size;
  const hasher = await Md5.create();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < size) {
    const length = Math.min(READ_CHUNK_SIZE, size - offset);
    const chunk = await reader.readChunk(transfer.localPath, offset, length);
    hasher.update(chunk);
    chunks.push(chunk);
    offset += length;
    onProgress?.(offset, size);
  }
  const body = concatChunks(chunks, size);
  const localMd5Hex = bytesToHex(hasher.digest());

  const res = await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: transfer.key, Body: body }),
    { abortSignal: signal },
  );
  const serverEtag = stripQuotes(res.ETag ?? "").toLowerCase();
  if (serverEtag !== localMd5Hex.toLowerCase()) {
    throw new VerificationError(
      "The uploaded file's checksum did not match what was sent.",
    );
  }
  log.debug("upload complete", transfer.key);
}
