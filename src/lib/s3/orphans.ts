// Silent orphan multipart-upload sweep (PLAN.md #7 / spec "orphaned uploads
// clean themselves up, invisibly"). No UI events, no logs surfaced, and it
// must never throw to the caller — a failure here is never actionable by
// the person using the app, so we swallow it.

import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import type { TransferStore } from "../types";

export interface OrphanSweepStats {
  scanned: number;
  aborted: number;
  errors: number;
}

const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Abort any multipart upload session older than `maxAgeMs` that has no
 * matching row in the local TransferStore. Always resolves — never
 * rejects — regardless of what S3 or the store do.
 */
export async function sweepOrphans(
  client: S3Client,
  store: TransferStore,
  connectionId: string,
  bucket: string,
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<OrphanSweepStats> {
  const stats: OrphanSweepStats = { scanned: 0, aborted: 0, errors: 0 };

  try {
    const known = await store.knownUploadIds(connectionId);

    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      let page;
      try {
        page = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );
      } catch {
        stats.errors += 1;
        break;
      }

      const uploads = page.Uploads ?? [];
      for (const upload of uploads) {
        stats.scanned += 1;
        const uploadId = upload.UploadId;
        const key = upload.Key;
        const initiated = upload.Initiated?.getTime();
        if (!uploadId || !key || initiated == null) continue;
        if (known.has(uploadId)) continue;
        const age = now - initiated;
        if (age < maxAgeMs) continue;

        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          );
          stats.aborted += 1;
        } catch {
          stats.errors += 1;
        }
      }

      isTruncated = Boolean(page.IsTruncated);
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
    }
  } catch {
    stats.errors += 1;
  }

  return stats;
}
