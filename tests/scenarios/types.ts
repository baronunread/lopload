// What a scenario is, and what it gets to work with.
//
// A scenario is a plain async function over a context — deliberately NOT a
// bun:test `test()`. That's what lets the same file run in two places:
//
//   bun test          tests/app.test.ts wraps each scenario in a bun test,
//                     against a Node host (fast; the inner loop).
//   bun run selftest  the app runs the same scenarios inside its own webview,
//                     against the real Tauri host — real Rust, real IPC.
//
// So: no imports from "bun:test" in this directory, ever. Assertions come in
// through ctx.expect, which each runner supplies.
import type { UserEvent } from "@testing-library/user-event";

import type { RealServicesHandle } from "../../src/services/real";
import type { BucketProbe } from "../support/bucketProbe";
import type { HostControl, HostRecord } from "../support/nodeHost";

/** Minimal assertion surface, so scenarios don't bind to a test runner. */
export interface Expect {
  (actual: unknown): {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeNull(): void;
    toContain(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
  };
}

export interface ScenarioCtx {
  /** The real AppServices — the same object App.tsx hands the UI. */
  services: RealServicesHandle;
  /** Direct bucket access, for arranging state and checking what really landed. */
  bucket: BucketProbe;
  /** The connection the app has been set up with, already saved and selected. */
  connectionId: string;
  /** A real, empty directory on disk: put files here to upload, look here after a download. */
  workdir: string;
  /** Scripts the answers native dialogs would give, and fires drag-and-drop. */
  control: HostControl;
  /** What the app told the OS: tray pushes, notifications, Finder reveals. */
  record: HostRecord;
  /** Drives the real UI. */
  user: UserEvent;
  expect: Expect;
  /** Writes a real local file into workdir and returns its absolute path. */
  makeLocalFile(name: string, bytes: Uint8Array | string): Promise<string>;
  /** Waits until `check` stops throwing, or fails. Use for anything async. */
  waitFor(check: () => void | Promise<void>, timeoutMs?: number): Promise<void>;
}

export interface Scenario {
  name: string;
  /** Skip in the in-app runner — for scenarios that can't work there (e.g. ones
   * needing fault injection, which lives on the Node host's fetch). */
  nodeOnly?: boolean;
  /**
   * Seed the bucket BEFORE the app mounts.
   *
   * This is not a style preference — it's required. The app lists the current
   * folder once on mount and does not poll, so anything `run()` puts in the
   * bucket afterwards races that listing and may simply never be shown. Arrange
   * here; act and assert in `run`.
   */
  arrange?(bucket: BucketProbe): Promise<void>;
  run(ctx: ScenarioCtx): Promise<void>;
}
