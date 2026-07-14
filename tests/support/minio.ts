// The one storage backend the test suite talks to: a real MinIO, speaking the
// real S3 protocol, over real HTTP.
//
// The container is *persistent by design*. `ensureMinio()` reuses a healthy
// one and never stops it, so the first run of the day pays the ~2s startup and
// every run after that — including every re-run under `bun test --watch` —
// pays nothing. Isolation comes from `freshBucket()` handing each suite its own
// bucket instead of from restarting the server. Run `bun run minio:stop` to
// tear it down.
//
// Port 9400, deliberately not 9000: that's what the old demo compose file
// squatted on, which is why the previous integration suite couldn't run locally
// alongside it.
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { spawnSync } from "node:child_process";

import { createS3Client } from "../../src/lib/s3/client";
import type { Connection, Credentials } from "../../src/lib/types";
import { nativeFetch } from "../setup";

export const CONTAINER_NAME = "lopload-test-minio";
export const MINIO_PORT = 9400;
export const MINIO_ENDPOINT = `http://127.0.0.1:${MINIO_PORT}`;
export const MINIO_REGION = "us-east-1";
export const MINIO_CREDENTIALS: Credentials = {
  accessKey: "minioadmin",
  secretKey: "minioadmin",
};

export interface Bucket {
  name: string;
  connection: Pick<Connection, "endpoint" | "region" | "bucket">;
  credentials: Credentials;
  /** An S3 client independent of the app's, for asserting on what really landed. */
  client: S3Client;
}

function docker(...args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("docker", args, { encoding: "utf-8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function healthy(): Promise<boolean> {
  try {
    const res = await nativeFetch(`${MINIO_ENDPOINT}/minio/health/live`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error(
    `MinIO never became healthy at ${MINIO_ENDPOINT}. ` +
      `Check \`docker logs ${CONTAINER_NAME}\`.`,
  );
}

let ensured: Promise<void> | null = null;

/**
 * Guarantees a healthy MinIO is listening, starting one only if it has to.
 *
 * Throws — never skips — when docker is unavailable. A test suite that
 * silently passes because its storage backend wasn't there is worse than no
 * suite at all; that's the failure mode this whole rework exists to remove.
 */
export function ensureMinio(): Promise<void> {
  return (ensured ??= (async () => {
    if (await healthy()) return;

    if (docker("version").status !== 0) {
      throw new Error(
        "Docker isn't running, and the test suite needs a real S3 backend.\n" +
          "Start Docker Desktop, then re-run. (The MinIO container is reused " +
          "across runs, so you only pay this once.)",
      );
    }

    // A container may exist but be stopped/unhealthy — clear it out rather
    // than fighting a half-dead one.
    docker("rm", "-f", CONTAINER_NAME);

    const run = docker(
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-p",
      `${MINIO_PORT}:9000`,
      "-e",
      `MINIO_ROOT_USER=${MINIO_CREDENTIALS.accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${MINIO_CREDENTIALS.secretKey}`,
      "minio/minio",
      "server",
      "/data",
    );
    if (run.status !== 0) throw new Error(`Failed to start MinIO: ${run.stderr}`);

    await waitForHealth();
  })());
}

/**
 * Creates a brand-new bucket and returns everything needed to point the app at
 * it. Call once per suite: buckets are how tests stay isolated from each other,
 * so they can run in parallel without anybody restarting the server.
 */
export async function freshBucket(): Promise<Bucket> {
  await ensureMinio();

  const name = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const connection = { endpoint: MINIO_ENDPOINT, region: MINIO_REGION, bucket: name };
  const client = createS3Client(connection, MINIO_CREDENTIALS, nativeFetch);

  await client.send(new CreateBucketCommand({ Bucket: name }));

  return { name, connection, credentials: MINIO_CREDENTIALS, client };
}
