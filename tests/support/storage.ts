// The storage every test talks to: real S3 protocol, real HTTP, real bytes.
//
// **Local (the default).** A MinIO container, *persistent by design*:
// `ensureMinio()` reuses a healthy one and never stops it, so the first run of
// the day pays the ~2s startup and every run after that — including every re-run
// under `bun test --watch` — pays nothing. Isolation comes from `freshBucket()`
// handing each suite its own bucket, not from restarting the server. Port 9400,
// deliberately not 9000, which the old demo compose file squatted on (and which
// is why the previous integration suite couldn't run locally alongside it).
// `bun run minio:stop` tears it down.
//
// **Remote (opt-in).** Set LOPLOAD_TEST_ENDPOINT and friends and the exact same
// suites run against a real provider — R2, S3, whatever — with no other change.
// That's the point of doing it here rather than in a parallel "e2e" tier: MinIO
// is an excellent S3 impersonator right up until it isn't, and the bugs that
// live in the gap (checksum middleware, ETag formats, redirect behaviour) are
// precisely the ones a local-only suite can never see.
//
// Remote mode isolates by **key prefix**, not by bucket: a provider token
// generally can't create buckets, and you'd be leaving litter across the account
// if it could. Every suite gets `lopload-test/<run>/`, the app is pointed at it
// as its starting folder, and the probe transparently scopes reads and writes to
// it — so a scenario that says `bucket.put("readme.txt")` still just works, and
// still cannot touch a single byte outside its own prefix.
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

/** Everything a remote run touches lives under this. Nothing outside it is ever
 * read, written, or deleted. */
export const REMOTE_ROOT = "lopload-test/";

export interface Bucket {
  name: string;
  connection: Pick<Connection, "endpoint" | "region" | "bucket">;
  credentials: Credentials;
  /** An S3 client independent of the app's, for asserting on what really landed. */
  client: S3Client;
  /**
   * The key prefix this suite is confined to. Empty for MinIO (it gets a whole
   * bucket to itself); `lopload-test/<run>/` for a remote provider.
   *
   * Callers hand this to the app as the connection's starting folder, and to
   * bucketProbe() so its reads and writes are scoped to the same place.
   */
  prefix: string;
}

interface RemoteConfig {
  endpoint: string;
  bucket: string;
  region: string;
  credentials: Credentials;
}

/**
 * Remote target, or null to use the local MinIO.
 *
 * Deliberately gated behind LOPLOAD_TEST_REMOTE=1 on top of the credentials.
 * Credentials sitting in a shell profile must not be enough to silently redirect
 * a routine `bun test` at somebody's production bucket — and only the scenario
 * suite is prefix-scoped (see freshBucket); the engine suites write keys at the
 * root and would litter. Opting in has to be a thing you meant to do.
 */
function remoteConfig(): RemoteConfig | null {
  if (process.env.LOPLOAD_TEST_REMOTE !== "1") return null;

  const endpoint = process.env.LOPLOAD_TEST_ENDPOINT;
  const bucket = process.env.LOPLOAD_TEST_BUCKET;
  const accessKey = process.env.LOPLOAD_TEST_ACCESS_KEY;
  const secretKey = process.env.LOPLOAD_TEST_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error(
      "LOPLOAD_TEST_REMOTE=1 but the remote target is incomplete — set " +
        "LOPLOAD_TEST_ENDPOINT, LOPLOAD_TEST_BUCKET, LOPLOAD_TEST_ACCESS_KEY and " +
        "LOPLOAD_TEST_SECRET_KEY. Refusing to quietly fall back to MinIO: you asked " +
        "for a real provider, and a green run against the wrong backend proves nothing.",
    );
  }
  return {
    endpoint,
    bucket,
    region: process.env.LOPLOAD_TEST_REGION || "auto",
    credentials: { accessKey, secretKey },
  };
}

/** True when the suite is pointed at a real provider rather than local MinIO. */
export function usingRemoteStorage(): boolean {
  return remoteConfig() !== null;
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

function runId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Somewhere isolated to run one suite, and everything needed to point the app at
 * it. Call once per suite — this is how tests stay out of each other's way, and
 * why they can run in parallel without anybody restarting anything.
 *
 * Locally that's a brand-new MinIO bucket. Against a real provider it's a fresh
 * key prefix inside the bucket you nominated (see the module comment for why).
 * Callers don't need to care which: pass `prefix` to the app as the connection's
 * starting folder and to bucketProbe(), and the suite reads the same either way.
 */
export async function freshBucket(): Promise<Bucket> {
  const remote = remoteConfig();

  if (remote) {
    const connection = {
      endpoint: remote.endpoint,
      region: remote.region,
      bucket: remote.bucket,
    };
    return {
      name: remote.bucket,
      connection,
      credentials: remote.credentials,
      client: createS3Client(connection, remote.credentials, nativeFetch),
      prefix: `${REMOTE_ROOT}${runId()}/`,
    };
  }

  await ensureMinio();

  const name = `t-${runId()}`;
  const connection = { endpoint: MINIO_ENDPOINT, region: MINIO_REGION, bucket: name };
  const client = createS3Client(connection, MINIO_CREDENTIALS, nativeFetch);

  await client.send(new CreateBucketCommand({ Bucket: name }));

  return { name, connection, credentials: MINIO_CREDENTIALS, client, prefix: "" };
}
