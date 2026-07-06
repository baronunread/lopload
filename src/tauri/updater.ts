// Thin wrapper around @tauri-apps/plugin-updater + @tauri-apps/plugin-process.
// Holds the last `Update` handle returned by check() so installAndRelaunch()
// doesn't need callers to thread it through — mirrors the single-purpose
// module style of notify.ts. Decision logic (when to check, what to say)
// lives in src/lib/updatePolicy.ts, kept framework- and Tauri-free.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pendingUpdate: Update | null = null;

/** Checks for a new release. Resolves with its version string if one is
 * available, otherwise null. */
export async function checkForUpdate(): Promise<string | null> {
  const update = await check();
  pendingUpdate = update;
  return update ? update.version : null;
}

/** Downloads and installs the update found by the last checkForUpdate()
 * call, then relaunches. No-op if there's nothing pending (e.g. called
 * twice, or before any check found an update). */
export async function installAndRelaunch(): Promise<void> {
  if (!pendingUpdate) return;
  await pendingUpdate.downloadAndInstall();
  await relaunch();
}
