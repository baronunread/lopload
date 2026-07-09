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
import { Md5, bytesToHex, compositeEtag } from "../md5";
import { createLogger } from "../logger";

const log = createLogger("multipart");

export const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
export const PART_SIZE = 8 * 1024 * 1024;

export interface LocalFileReader {
  size(path: string): Promise<number>;
  readChunk(path: string, offset: number, length: number): Promise<Uint8Array>;
}

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
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Parallel UploadPart requests per file. Defaults to 1 (sequential). */
  partsInFlight?: number;
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

export async function uploadTransfer(
  transfer: Transfer,
  deps: MultipartDeps,
): Promise<void> {
  log.debug("starting upload", transfer.key, { size: transfer.size });
  if (transfer.size < MULTIPART_THRESHOLD && !transfer.uploadId) {
    await uploadSinglePart(transfer, deps);
  } else {
    await uploadMultipart(transfer, deps);
  }
  log.debug("upload complete", transfer.key);
}

async function uploadSinglePart(
  transfer: Transfer,
  deps: MultipartDeps,
): Promise<void> {
  const { client, bucket, reader, onProgress, signal } = deps;
  const size = transfer.size;
  const hasher = await Md5.create();
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
}

async function uploadMultipart(
  transfer: Transfer,
  deps: MultipartDeps,
): Promise<void> {
  const { client, bucket, reader, store, onProgress, signal } = deps;
  const partsInFlight = Math.max(1, deps.partsInFlight ?? 1);

  let uploadId = transfer.uploadId;
  if (!uploadId) {
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: transfer.key }),
      { abortSignal: signal },
    );
    if (!created.UploadId) {
      throw new Error("CreateMultipartUpload did not return an UploadId");
    }
    uploadId = created.UploadId;
    transfer.uploadId = uploadId;
    await store.save({ ...transfer, uploadId });
  }

  const totalParts = Math.ceil(transfer.size / transfer.partSize);
  const persisted = await store.listParts(transfer.id);
  const persistedByNumber = new Map(persisted.map((p) => [p.partNumber, p]));

  let serverParts: { PartNumber?: number; ETag?: string; Size?: number }[] = [];
  try {
    const listed = await client.send(
      new ListPartsCommand({ Bucket: bucket, Key: transfer.key, UploadId: uploadId }),
      { abortSignal: signal },
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

  const partLength = (partNumber: number): number => {
    const offset = (partNumber - 1) * transfer.partSize;
    return Math.min(transfer.partSize, transfer.size - offset);
  };

  // First pass: parts already on the server count as done up front.
  const pending: number[] = [];
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const length = partLength(partNumber);
    const serverPart = serverByNumber.get(partNumber);

    if (serverPart?.ETag && serverPart.Size === length) {
      const etag = serverPart.ETag;
      const part: TransferPart = { transferId: transfer.id, partNumber, etag, size: length };
      finalParts.push(part);
      const existing = persistedByNumber.get(partNumber);
      if (!existing || existing.etag !== etag || existing.size !== length) {
        await store.saveParts([part]);
      }
      bytesDone += length;
      onProgress?.(bytesDone, transfer.size);
    } else {
      pending.push(partNumber);
    }
  }

  // Worker pool: each worker holds one chunk at a time, so memory stays
  // bounded at partsInFlight × partSize.
  if (pending.length > 0) {
    const local = new AbortController();
    const abortLocal = () => local.abort(signal?.reason);
    if (signal?.aborted) abortLocal();
    else signal?.addEventListener("abort", abortLocal);

    let firstError: unknown;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (local.signal.aborted) return;
        const partNumber = pending.shift();
        if (partNumber === undefined) return;
        const offset = (partNumber - 1) * transfer.partSize;
        const length = partLength(partNumber);
        const chunk = await reader.readChunk(transfer.localPath, offset, length);
        const res = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: transfer.key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: chunk,
          }),
          { abortSignal: local.signal },
        );
        const etag = res.ETag ?? "";
        const part: TransferPart = { transferId: transfer.id, partNumber, etag, size: length };
        await store.saveParts([part]);
        finalParts.push(part);
        bytesDone += length;
        onProgress?.(bytesDone, transfer.size);
      }
    };

    const workers = Array.from(
      { length: Math.min(partsInFlight, pending.length) },
      () =>
        worker().catch((err) => {
          firstError ??= err;
          local.abort(err);
        }),
    );
    try {
      await Promise.all(workers);
    } finally {
      signal?.removeEventListener("abort", abortLocal);
    }
    if (signal?.aborted) throw signal.reason ?? firstError;
    if (firstError !== undefined) throw firstError;
  }

  finalParts.sort((a, b) => a.partNumber - b.partNumber);

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: transfer.key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: finalParts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
      },
    }),
    { abortSignal: signal },
  );

  const head = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: transfer.key }),
    { abortSignal: signal },
  );

  const expectedEtag = await compositeEtag(finalParts.map((p) => stripQuotes(p.etag)));
  const actualEtag = stripQuotes(head.ETag ?? "").toLowerCase();

  if (head.ContentLength !== transfer.size || actualEtag !== expectedEtag.toLowerCase()) {
    log.warn("multipart verification failed", transfer.key, {
      expectedSize: transfer.size,
      actualSize: head.ContentLength,
      expectedEtag,
      actualEtag,
    });
    throw new VerificationError(
      "The uploaded file's size or checksum did not match what was sent.",
    );
  }
}