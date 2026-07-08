import { Upload } from "@aws-sdk/lib-storage";
import { ChecksumAlgorithm } from "@aws-sdk/client-s3";
import { createCRC32 } from "hash-wasm";

import type { Transfer } from "../types";
import { createLogger } from "../logger";

const log = createLogger("upload");
const READ_CHUNK_SIZE = 8 * 1024 * 1024;
const PART_SIZE = 5 * 1024 * 1024;

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

export interface UploadDeps {
  client: import("@aws-sdk/client-s3").S3Client;
  bucket: string;
  reader: LocalFileReader;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

export async function uploadTransfer(
  transfer: Transfer,
  deps: UploadDeps,
): Promise<void> {
  const { client, bucket, reader, onProgress, signal } = deps;
  const size = transfer.size;
  const hasher = await createCRC32();
  hasher.init();
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

  const crc32Bytes = hasher.digest("binary") as Uint8Array;
  const localCrc32 = btoa(String.fromCharCode(...crc32Bytes));
  const body = new Blob(chunks);

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: transfer.key,
      Body: body,
      ChecksumAlgorithm: ChecksumAlgorithm.CRC32,
    },
    queueSize: 4,
    partSize: PART_SIZE,
    leavePartsOnError: false,
  });

  if (signal) {
    signal.addEventListener("abort", () => upload.abort());
  }

  const result = await upload.done();

  if (result.ChecksumCRC32 && result.ChecksumCRC32 !== localCrc32) {
    throw new VerificationError(
      "The uploaded file's checksum did not match what was sent.",
    );
  }
  log.debug("upload complete", transfer.key);
}
