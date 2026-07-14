// Reads and writes a bucket *around* the app, never through it.
//
// Scenarios use this for two jobs the app itself must not be trusted with:
// arranging state before the act (seeding objects), and checking the result
// after it (did those bytes really land?). Deliberately built on its own
// S3Client — asserting with the same client the app uses would let a bug in
// the app's client hide itself.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface BucketProbe {
  /** Writes an object directly, bypassing the app. */
  put(key: string, body: Uint8Array | string): Promise<void>;
  /** Reads an object's bytes, or null if it isn't there. */
  get(key: string): Promise<Uint8Array | null>;
  /** Reads an object as text, or null if it isn't there. */
  getText(key: string): Promise<string | null>;
  /** True when the key exists. */
  has(key: string): Promise<boolean>;
  /** Every key under a prefix, sorted. */
  keys(prefix?: string): Promise<string[]>;
  /** Deletes everything under a prefix. */
  clear(prefix?: string): Promise<void>;
}

export function bucketProbe(client: S3Client, bucket: string): BucketProbe {
  const probe: BucketProbe = {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: typeof body === "string" ? new TextEncoder().encode(body) : body,
        }),
      );
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return new Uint8Array(await res.Body!.transformToByteArray());
      } catch {
        return null;
      }
    },

    async getText(key) {
      const bytes = await probe.get(key);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },

    async has(key) {
      return (await probe.get(key)) !== null;
    },

    async keys(prefix = "") {
      const found: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of res.Contents ?? []) if (obj.Key) found.push(obj.Key);
        token = res.NextContinuationToken;
      } while (token);
      return found.sort();
    },

    async clear(prefix = "") {
      const keys = await probe.keys(prefix);
      if (keys.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    },
  };

  return probe;
}
