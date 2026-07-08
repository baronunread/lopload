// Pure decision logic for auto-update checking and notice copy. Framework-
// free and Tauri-free so it can be unit-tested without mocking the updater
// plugin — see src/tauri/updater.ts for the actual plugin calls.

/** How often to re-check for an update while the app stays open. Startup
 * always checks regardless of this (call shouldCheckForUpdate with
 * lastCheckedAt = null on first check). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether enough time has passed (or this is the first check) to check
 * for an update again. */
export function shouldCheckForUpdate(now: number, lastCheckedAt: number | null): boolean {
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

export interface UpdateNotice {
  title: string;
  body: string;
  actionLabel: string;
}

/** Copy for the "an update is ready" notice. */
export function buildUpdateNotice(hasTransfersInFlight: boolean): UpdateNotice {
  if (hasTransfersInFlight) {
    return {
      title: "A new version is ready",
      body: "Your transfers will be interrupted. They'll show as failed after restart.",
      actionLabel: "Restart and update",
    };
  }
  return {
    title: "A new version is ready",
    body: "Restart to update.",
    actionLabel: "Restart and update",
  };
}
