import { describe, expect, test } from "bun:test";
import { selectStaleSessionLogs, type LogEntry } from "../../src/tauri/logSink";

function makeSessions(count: number, mtimeStart: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `lopload-session-${i}.log`,
    mtime: mtimeStart + i,
  }));
}

describe("logSink/selectStaleSessionLogs", () => {
  test("keeps everything when there are fewer sessions than the limit", () => {
    const sessions = makeSessions(5, 1000);
    expect(selectStaleSessionLogs(sessions, 20)).toEqual([]);
  });

  test("deletes excess sessions regardless of age — the bug this replaces required 30+ days old too", () => {
    // All sessions are "recent" (same narrow mtime range, as they'd be if
    // created minutes apart during one burst of dev restarts) — the old
    // filter (candidates beyond MAX_FILES AND older than 30 days) would
    // have kept every single one of these forever.
    const now = Date.now();
    const sessions = makeSessions(25, now);
    const stale = selectStaleSessionLogs(sessions, 20);
    expect(stale.length).toBe(5);
    // The 5 oldest (lowest mtime) are the ones selected for deletion.
    expect(stale.map((s) => s.name).sort()).toEqual(
      ["lopload-session-0.log", "lopload-session-1.log", "lopload-session-2.log", "lopload-session-3.log", "lopload-session-4.log"].sort(),
    );
  });

  test("keeps exactly maxFiles when there are more sessions than the limit", () => {
    const sessions = makeSessions(30, Date.now());
    const stale = selectStaleSessionLogs(sessions, 20);
    expect(stale.length).toBe(10);
  });

  test("does not mutate the input array", () => {
    const sessions = makeSessions(25, Date.now());
    const copy = [...sessions];
    selectStaleSessionLogs(sessions, 20);
    expect(sessions).toEqual(copy);
  });
});
