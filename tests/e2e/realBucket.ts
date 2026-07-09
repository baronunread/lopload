// Shared helper for the real-bucket e2e suite: builds an S3Client against a
// real bucket (R2, S3, or any S3-compatible endpoint) from environment
// variables, using global fetch (no webview here). Returns null when any
// required var is unset so suites can skip cleanly instead of failing —
// this suite is opt-in and must never run against a real bucket by accident.

import type { S3Client } from "@aws-sdk/client-s3";

import { createS3Client } from "../../src/lib/s3/client";
import type { Connection, Credentials } from "../../src/lib/types";

export interface RealBucketHandle {
  client: S3Client;
  connection: Pick<Connection, "endpoint" | "region" | "bucket">;
  bucket: string;
}

const REQUIRED_VARS = [
  "LOPLOAD_E2E_ENDPOINT",
  "LOPLOAD_E2E_BUCKET",
  "LOPLOAD_E2E_ACCESS_KEY",
  "LOPLOAD_E2E_SECRET_KEY",
] as const;

/**
 * Builds a real-bucket handle from env vars, or returns null (never throws)
 * if any required var is missing, so callers can skip their suite cleanly.
 */
export function realBucket(): RealBucketHandle | null {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.warn(
      `[e2e] missing env vars (${missing.join(", ")}) — skipping real-bucket e2e tests. ` +
        "See .env.e2e.example.",
    );
    return null;
  }

  const endpoint = process.env.LOPLOAD_E2E_ENDPOINT!;
  const bucket = process.env.LOPLOAD_E2E_BUCKET!;
  const region = process.env.LOPLOAD_E2E_REGION || "auto";
  const credentials: Credentials = {
    accessKey: process.env.LOPLOAD_E2E_ACCESS_KEY!,
    secretKey: process.env.LOPLOAD_E2E_SECRET_KEY!,
  };

  const connection = { endpoint, region, bucket };
  const client = createS3Client(connection, credentials, fetch);

  return { client, connection, bucket };
}
