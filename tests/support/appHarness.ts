// Assembles a running instance of the real app for one scenario, and tears it
// down afterwards.
//
// "Real" is meant literally: the AppShell React tree the user sees, wired to
// RealServices, wired to a TransferEngine, wired to an S3 client that signs
// genuine SigV4 requests to a genuine MinIO. The only substitutions are the
// Host's (see nodeHost.ts) — the OS surfaces a test can't have.
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AppShell } from "../../src/ui/AppShell";
import { ServicesProvider } from "../../src/ui/services";
import { createRealServices } from "../../src/services/real";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { bucketProbe, type BucketProbe } from "./bucketProbe";
import { freshBucket } from "./minio";
import { createNodeHost } from "./nodeHost";
import type { Expect, ScenarioCtx } from "../scenarios/types";

export interface HarnessOptions {
  /** Save a connection and select it before mounting. Default true; onboarding
   * scenarios want false so the app comes up on its first-run screen. */
  connected?: boolean;
  /** Wrap the host's fetch — used by fault-injection scenarios (see faultyFetch.ts). */
  wrapFetch?: (inner: FetchFn) => FetchFn;
  /** Seed the bucket before the app is rendered. The app lists once on mount and
   * doesn't poll, so state that arrives after render can lose the race and never
   * appear — see Scenario.arrange. */
  arrange?(bucket: BucketProbe): Promise<void>;
}

export interface Harness extends ScenarioCtx {
  dispose(): Promise<void>;
}

const CONNECTION_ID = "test-connection";

/**
 * Waits until `check` stops throwing. Scenarios lean on this constantly:
 * everything the app does now involves real I/O, so almost nothing is true
 * on the next tick.
 */
export async function waitFor(
  check: () => void | Promise<void>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("waitFor timed out");
}

export async function mountApp(
  expect: Expect,
  options: HarnessOptions = {},
): Promise<Harness> {
  const { connected = true, wrapFetch, arrange } = options;

  const bucket = await freshBucket();
  const probe = bucketProbe(bucket.client, bucket.name);
  const { host, record, control, workdir } = await createNodeHost();

  if (wrapFetch) host.fetch = wrapFetch(host.fetch);

  // Everything the scenario wants to already be there must land before render() —
  // the app lists on mount and never polls.
  await arrange?.(probe);

  const services = createRealServices(host);

  if (connected) {
    await services.connections.save(
      {
        id: CONNECTION_ID,
        name: "Test Storage",
        endpoint: bucket.connection.endpoint,
        bucket: bucket.name,
        region: bucket.connection.region,
        lastPrefix: "",
        createdAt: Date.now(),
      },
      bucket.credentials,
    );
  }

  render(
    createElement(ServicesProvider, { value: services }, createElement(AppShell)),
  );

  return {
    services,
    bucket: probe,
    connectionId: CONNECTION_ID,
    workdir,
    control,
    record,
    user: userEvent.setup(),
    expect,
    waitFor,

    async makeLocalFile(name, bytes) {
      const path = join(workdir, name);
      await writeFile(path, bytes);
      return path;
    },

    async readLocalFile(path) {
      return new Uint8Array(await readFile(path));
    },

    async dispose() {
      cleanup();
      // Stops the trash sweep's 24h timer and cancels anything still in flight,
      // so no straggler outlives the scenario that started it.
      await services.dispose();
    },
  };
}
