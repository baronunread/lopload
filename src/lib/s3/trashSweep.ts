// Silent trash purge sweep — permanently deletes anything under the trash
// location older than the retention window. No UI events, no logs surfaced,
// and it must never throw to the caller.

import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

import { isExpired, parseTrashKey, TRASH_PREFIX, TRASH_RETENTION_MS } from "./trash";

export interface TrashSweepStats {
  scanned: number;
  purged: number;
  errors: number;
}

const DELETE_BATCH_SIZE = 1000;

/**
 * Permanently deletes every trashed object older than `maxAgeMs`. Always
 * resolves — never rejects — regardless of what S3 does.
 */
export async function sweepTrash(
  client: S3Client,
  bucket: string,
  now: number,
  maxAgeMs: number = TRASH_RETENTION_MS,
): Promise<TrashSweepStats> {
  const stats: TrashSweepStats = { scanned: 0, purged: 0, errors: 0 };
  const expiredKeys: string[] = [];

  try {
    let continuationToken: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      let page;
      try {
        page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: TRASH_PREFIX,
            ContinuationToken: continuationToken,
          }),
        );
      } catch {
        stats.errors += 1;
        break;
      }

      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue;
        stats.scanned += 1;
        const parsed = parseTrashKey(obj.Key);
        if (!parsed) continue;
        if (isExpired(parsed.deletedAtMs, now, maxAgeMs)) expiredKeys.push(obj.Key);
      }

      isTruncated = Boolean(page.IsTruncated);
      continuationToken = page.NextContinuationToken;
    }

    for (let i = 0; i < expiredKeys.length; i += DELETE_BATCH_SIZE) {
      const batch = expiredKeys.slice(i, i + DELETE_BATCH_SIZE);
      try {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        );
        stats.purged += batch.length;
      } catch {
        stats.errors += 1;
      }
    }
  } catch {
    stats.errors += 1;
  }

  return stats;
}
