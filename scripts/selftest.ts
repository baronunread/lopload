#!/usr/bin/env bun
// Runs Runner B: the same tests/scenarios/* list as `bun test
// tests/app.test.ts`, but inside the real Tauri binary (src/selftest/mount.tsx)
// instead of a Node host — real webview, real Rust IPC, real MinIO.
//
// This script:
//   1. makes sure a real MinIO is up and hands it a fresh bucket (reusing the
//      exact container logic tests/support/minio.ts already has — this runs
//      under bun, not the webview, so importing it is fine here),
//   2. launches `bunx tauri dev` with VITE_LOPLOAD_SELFTEST=1 and that
//      bucket's connection details as VITE_LOPLOAD_SELFTEST_* env vars,
//   3. streams the app's stdout to ours (so a `bun run selftest` looks like
//      any other test run), watching for the sentinel line mount.tsx prints
//      once every scenario has run,
//   4. exits with 0/1 accordingly.
//
// `tauri dev`'s own exit code isn't trustworthy here — it's a long-running
// dev-server wrapper, not a one-shot test binary — so this parses the
// sentinel line out of its stdout rather than waiting on its exit code.
import { resolve } from "node:path";

import { ensureMinio, freshBucket } from "../tests/support/minio";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Not 14320 — that's normal `bun run tauri dev`, and Vite's strictPort makes a
 * collision fatal. The self-test runs alongside an app you already have open. */
const SELFTEST_PORT = 14330;

/** Overall time budget: MinIO startup + app boot + all scenarios. Generous —
 * a cold `cargo build` inside `tauri dev` can itself take a couple of
 * minutes the first time. */
const OVERALL_TIMEOUT_MS = 10 * 60_000;
/** Once the sentinel line is seen, how long to wait for the app to exit on
 * its own (app.exit() -> tauri-cli tears down the dev server) before this
 * script kills it itself, so a flaky shutdown never hangs the terminal. */
const SHUTDOWN_GRACE_MS = 10_000;

const RESULT_LINE = /SELFTEST_RESULT (PASS|FAIL)/;

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  onLine: (line: string) => void,
  echo: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      echo(line + "\n");
      onLine(line);
    }
  }
  if (buffer.length > 0) {
    echo(buffer);
    onLine(buffer);
  }
}

async function main(): Promise<number> {
  console.log("selftest: ensuring MinIO is up...");
  await ensureMinio();
  const bucket = await freshBucket();
  console.log(`selftest: bucket ${bucket.name} ready at ${bucket.connection.endpoint}`);

  // Its own dev-server port, so running the self-test doesn't require you to
  // shut down a `bun run tauri dev` you already have open. vite.config.ts reads
  // LOPLOAD_VITE_PORT (strictPort would otherwise make the collision fatal), and
  // Tauri needs its devUrl pointed at the same place.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LOPLOAD_VITE_PORT: String(SELFTEST_PORT),
    VITE_LOPLOAD_SELFTEST: "1",
    VITE_LOPLOAD_SELFTEST_ENDPOINT: bucket.connection.endpoint,
    VITE_LOPLOAD_SELFTEST_BUCKET: bucket.name,
    VITE_LOPLOAD_SELFTEST_REGION: bucket.connection.region,
    VITE_LOPLOAD_SELFTEST_ACCESS_KEY: bucket.credentials.accessKey,
    VITE_LOPLOAD_SELFTEST_SECRET_KEY: bucket.credentials.secretKey,
  };

  console.log(`selftest: launching \`bunx tauri dev\` on port ${SELFTEST_PORT}...`);
  const proc = Bun.spawn({
    cmd: [
      "bunx",
      "tauri",
      "dev",
      "--config",
      JSON.stringify({ build: { devUrl: `http://localhost:${SELFTEST_PORT}` } }),
    ],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let resultCode: number | null = null;
  let sawResult = () => {};
  const resultSeen = new Promise<void>((resolve) => {
    sawResult = resolve;
  });

  const onLine = (line: string) => {
    const match = line.match(RESULT_LINE);
    if (match && resultCode === null) {
      resultCode = match[1] === "PASS" ? 0 : 1;
      sawResult();
    }
  };

  const pumping = Promise.all([
    pump(proc.stdout, onLine, (s) => process.stdout.write(s)),
    pump(proc.stderr, onLine, (s) => process.stderr.write(s)),
  ]);

  const timedOut = await Promise.race([
    resultSeen.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), OVERALL_TIMEOUT_MS)),
  ]);

  if (timedOut) {
    console.error(
      `selftest: timed out after ${OVERALL_TIMEOUT_MS}ms waiting for a SELFTEST_RESULT line`,
    );
    proc.kill();
    await pumping.catch(() => {});
    return 1;
  }

  // The app calls selftest_exit(), which should tear down `tauri dev` (and
  // the frontend dev server it spawned) on its own. Give that a moment, then
  // make sure nothing's left running either way.
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)),
  ]);
  if (!exited) {
    console.warn("selftest: app didn't exit on its own — killing the dev process tree");
    proc.kill();
  }
  await pumping.catch(() => {});

  return resultCode ?? 1;
}

main()
  .then((code) => {
    console.log(code === 0 ? "selftest: PASS" : "selftest: FAIL");
    process.exit(code);
  })
  .catch((err) => {
    console.error("selftest: crashed", err);
    process.exit(1);
  });
