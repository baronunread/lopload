// Manually-triggered cleanup for multipart uploads that were started but
// never completed — a crash (or force-quit) before CompleteMultipartUpload
// leaves an open UploadId on S3 and a `failed` transfer row pointing at it.
// resumePending() already re-queues anything still resumable; what's left
// after that (uploadId set, transfer stuck in `failed`) is dead weight S3
// would otherwise only clean up after its own 7-day default lifecycle rule.
//
// This never runs automatically — it's a user-initiated Settings action,
// so it only ever touches transfers already in the terminal `failed` state.

import { AbortMultipartUploadCommand, type S3Client } from "@aws-sdk/client-s3";

import type { TransferStore } from "../types";
import { createLogger } from "../logger";

const log = createLogger("orphan-sweep");

export interface AbortStaleUploadsStats {
  aborted: number;
  errors: number;
}

export async function abortStaleUploads(
  client: S3Client,
  bucket: string,
  store: TransferStore,
  connectionId: string,
): Promise<AbortStaleUploadsStats> {
  const stats: AbortStaleUploadsStats = { aborted: 0, errors: 0 };
  const transfers = await store.list(connectionId);
  const stale = transfers.filter(
    (transfer) =>
      transfer.direction === "upload" && transfer.uploadId && transfer.state.kind === "failed",
  );

  await Promise.all(
    stale.map(async (transfer) => {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: transfer.key,
            UploadId: transfer.uploadId,
          }),
        );
      } catch (err) {
        // Already gone (expired, or a previous sweep aborted it) is as good
        // as aborted — nothing left to clean up server-side.
        if (err instanceof Error && err.name !== "NoSuchUpload") {
          log.warn("abort stale upload failed", transfer.key, err);
          stats.errors += 1;
          return;
        }
      }
      await store.save({ ...transfer, uploadId: undefined });
      stats.aborted += 1;
    }),
  );

  return stats;
}
