// Shared helper for integration tests: spins up a real MinIO container via
// docker, waits for it to accept connections, and builds an S3Client wired
// with global fetch (not @tauri-apps/plugin-http — there's no webview here).
// If docker is unavailable, `startMinio()` returns null and callers should
// skip their suite with a clear console message instead of failing.

import {
  CreateBucketCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { execSync, spawnSync } from "node:child_process";

import { createS3Client } from "../../src/lib/s3/client";
import type { Connection, Credentials } from "../../src/lib/types";

export const CONTAINER_NAME = "lopload-test-minio";
export const MINIO_PORT = 9000;
export const TEST_BUCKET = "lopload-test-bucket";
export const TEST_CREDENTIALS: Credentials = {
  accessKey: "minioadmin",
  secretKey: "minioadmin",
};

export interface MinioHandle {
  client: S3Client;
  connection: Pick<Connection, "endpoint" | "region" | "bucket">;
  stop(): Promise<void>;
}

/** True if the `docker` CLI is present and the daemon is reachable. */
export function dockerAvailable(): boolean {
  const check = spawnSync("docker", ["version"], { stdio: "ignore" });
  return check.status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMinio(endpoint: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${endpoint}/minio/health/live`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`MinIO never became healthy at ${endpoint}: ${String(lastErr)}`);
}

/**
 * Starts a fresh MinIO container, waits for readiness, and creates the test
 * bucket. Returns null (never throws) if docker is unavailable so callers
 * can skip cleanly.
 */
export async function startMinio(): Promise<MinioHandle | null> {
  if (!dockerAvailable()) return null;

  // Clean up any leftover container from a previous crashed run.
  spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });

  const run = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "-p",
      `${MINIO_PORT}:9000`,
      "--name",
      CONTAINER_NAME,
      "-e",
      "MINIO_ROOT_USER=minioadmin",
      "-e",
      "MINIO_ROOT_PASSWORD=minioadmin",
      "minio/minio",
      "server",
      "/data",
    ],
    { encoding: "utf-8" },
  );
  if (run.status !== 0) {
    throw new Error(`docker run for MinIO failed: ${run.stderr}`);
  }

  const endpoint = `http://127.0.0.1:${MINIO_PORT}`;
  await waitForMinio(endpoint);

  const connection = { endpoint, region: "us-east-1", bucket: TEST_BUCKET };
  const client = createS3Client(connection, TEST_CREDENTIALS, fetch);

  await client.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));

  return {
    client,
    connection,
    async stop() {
      spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { stdio: "ignore" });
    },
  };
}

/** Best-effort synchronous check used only for a friendly skip message. */
export function dockerVersionString(): string {
  try {
    return execSync("docker version --format '{{.Server.Version}}'", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}
