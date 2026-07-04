// Manual multipart upload engine (PLAN.md #1, #3, #6, #9). No automatic
// lib-storage helper is used — part ETags and the upload ID are persisted
// as they're produced so an app/machine restart can resume from the last
// completed part via ListParts reconciliation instead of starting over.

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import type { Transfer, TransferPart, TransferStore } from "../types";
import { Md5, compositeEtag } from "../md5";

/** Files at or above this size use multipart upload; smaller use a single PUT. */
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
/** Multipart part size. */
export const PART_SIZE = 8 * 1024 * 1024;

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

export interface MultipartDeps {
  client: S3Client;
  bucket: string;
  reader: LocalFileReader;
  store: TransferStore;
  /** Called after each chunk of bytes is confirmed sent, for progress UI. */
  onProgress?: (bytesSent: number, totalBytes: number) => void;
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
  deps: MultipartDeps,
): Promise<void> {
  if (transfer.size < MULTIPART_THRESHOLD && !transfer.uploadId) {
    await uploadSinglePart(transfer, deps);
  } else {
    await uploadMultipart(transfer, deps);
  }
}

async function uploadSinglePart(
  transfer: Transfer,
  deps: MultipartDeps,
): Promise<void> {
  const { client, bucket, reader, onProgress } = deps;
  const size = transfer.size;
  const hasher = new Md5();
  const chunks: Uint8Array[] = [];
  const readChunkSize = PART_SIZE;
  let offset = 0;
  while (offset < size) {
    const length = Math.min(readChunkSize, size - offset);
    const chunk = await reader.readChunk(transfer.localPath, offset, length);
    hasher.update(chunk);
    chunks.push(chunk);
    offset += length;
    onProgress?.(offset, size);
  }
  const body = concatChunks(chunks, size);
  const localMd5Hex = Array.from(hasher.digest())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const res = await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: transfer.key, Body: body }),
  );
  const serverEtag = stripQuotes(res.ETag ?? "").toLowerCase();
  if (serverEtag !== localMd5Hex.toLowerCase()) {
    throw new VerificationError(
      "The uploaded file's checksum did not match what was sent.",
    );
  }
}

async function uploadMultipart(
  transfer: Transfer,
  deps: MultipartDeps,
): Promise<void> {
  const { client, bucket, reader, store, onProgress } = deps;

  let uploadId = transfer.uploadId;
  if (!uploadId) {
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: transfer.key }),
    );
    if (!created.UploadId) {
      throw new Error("CreateMultipartUpload did not return an UploadId");
    }
    uploadId = created.UploadId;
    // Persist immediately — this is what makes resume possible after a crash.
    await store.save({ ...transfer, uploadId });
  }

  const totalParts = Math.ceil(transfer.size / transfer.partSize);
  const persisted = await store.listParts(transfer.id);
  const persistedByNumber = new Map(persisted.map((p) => [p.partNumber, p]));

  // Reconcile against server truth before trusting local records — the
  // server may have parts we don't know about, or vice versa.
  let serverParts: { PartNumber?: number; ETag?: string; Size?: number }[] = [];
  try {
    const listed = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: transfer.key, UploadId: uploadId }),
    );
    serverParts = listed.Parts ?? [];
  } catch {
    serverParts = [];
  }
  const serverByNumber = new Map(
    serverParts
      .filter((p): p is { PartNumber: number; ETag?: string; Size?: number } =>
        p.PartNumber != null,
      )
      .map((p) => [p.PartNumber, p]),
  );

  const finalParts: TransferPart[] = [];
  let bytesDone = 0;

  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const offset = (partNumber - 1) * transfer.partSize;
    const length = Math.min(transfer.partSize, transfer.size - offset);
    const serverPart = serverByNumber.get(partNumber);

    if (serverPart?.ETag && serverPart.Size === length) {
      // Already uploaded (server truth) — no re-upload needed.
      const etag = serverPart.ETag;
      const part: TransferPart = { transferId: transfer.id, partNumber, etag, size: length };
      finalParts.push(part);
      const existing = persistedByNumber.get(partNumber);
      if (!existing || existing.etag !== etag || existing.size !== length) {
        await store.saveParts([part]);
      }
      bytesDone += length;
      onProgress?.(bytesDone, transfer.size);
      continue;
    }

    const chunk = await reader.readChunk(transfer.localPath, offset, length);
    const res = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: transfer.key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: chunk,
      }),
    );
    const etag = res.ETag ?? "";
    const part: TransferPart = { transferId: transfer.id, partNumber, etag, size: length };
    finalParts.push(part);
    await store.saveParts([part]);
    bytesDone += length;
    onProgress?.(bytesDone, transfer.size);
  }

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: transfer.key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: finalParts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
      },
    }),
  );

  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: transfer.key }),
  );

  const expectedEtag = compositeEtag(finalParts.map((p) => stripQuotes(p.etag)));
  const actualEtag = stripQuotes(head.ETag ?? "").toLowerCase();

  if (head.ContentLength !== transfer.size || actualEtag !== expectedEtag.toLowerCase()) {
    throw new VerificationError(
      "The uploaded file's size or checksum did not match what was sent.",
    );
  }
}
