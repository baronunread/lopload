import { appLogDir } from "@tauri-apps/api/path";
import { writeTextFile, mkdir, readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { addLogSink } from "../lib/logger";

const MAX_FILES = 20;

let logPath: string | null = null;
let initialized = false;

function fileSafeISODate(): string {
  const n = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}-${pad(n.getMinutes())}-${pad(n.getSeconds())}`;
}

export interface LogEntry {
  name: string;
  mtime: number;
}

/**
 * Pure "which files to delete" decision, split out from the directory I/O
 * below so it can be unit tested without a real filesystem. Always keeps
 * only the newest `maxFiles` sessions — age plays no part, so a directory
 * full of recent-but-excess sessions actually gets trimmed instead of
 * waiting a month (the bug this replaces: the old filter required a file to
 * be BOTH beyond the count limit AND 30+ days old before it was removed).
 */
export function selectStaleSessionLogs(sessions: LogEntry[], maxFiles: number): LogEntry[] {
  return [...sessions].sort((a, b) => b.mtime - a.mtime).slice(maxFiles);
}

async function listSessionLogs(dir: string): Promise<LogEntry[]> {
  const files = await readDir(dir).catch<[]>(() => []);
  const names = files.flatMap((f) =>
    !f.isDirectory && f.name && f.name.startsWith("lopload-") && f.name.endsWith(".log")
      ? [f.name]
      : [],
  );

  // Parallel, not sequential: with hundreds of session files sitting around
  // (see selectStaleSessionLogs above for why that used to happen), stat-ing
  // them one at a time added up to a real delay — long enough that it used
  // to run *before* the file sink attached, so an app launch immediately
  // followed by an upload could fail before its own error log line was ever
  // eligible to reach disk.
  const entries = await Promise.all(
    names.map(async (name): Promise<LogEntry | null> => {
      const s = await stat(`${dir}/${name}`).catch(() => null);
      return s ? { name, mtime: +(s.mtime ?? 0) } : null;
    }),
  );
  return entries.filter((e): e is LogEntry => e !== null);
}

async function cleanup(dir: string): Promise<void> {
  const sessions = await listSessionLogs(dir);
  const stale = selectStaleSessionLogs(sessions, MAX_FILES);
  await Promise.all(stale.map((f) => remove(`${dir}/${f.name}`).catch(() => {})));
}

export async function initFileLogSink(): Promise<void> {
  // Idempotent per process: the app itself only ever calls this once, but
  // the in-app self-test host (src/selftest/mount.tsx) builds a fresh
  // Services — and with it a fresh call to this function — for every single
  // scenario in the run. Without this guard that meant one session-log file
  // per scenario (the actual source of the "several files created in the
  // same second" proliferation), and worse: every prior call's sink closure
  // reads the same module-level `logPath`, so once two sinks were stacked
  // every log line got written twice into whatever file was current — a
  // real duplicate-line bug, confirmed in production logs.
  if (initialized) return;

  let dir: string;
  try {
    dir = await appLogDir();
    await mkdir(dir, { recursive: true });
  } catch {
    // Not marked initialized: a transient failure here (e.g. the directory
    // isn't ready yet) shouldn't permanently rule out a later, successful
    // attempt the way setting the flag unconditionally would.
    return;
  }
  initialized = true;

  logPath = `${dir}/lopload-${fileSafeISODate()}.log`;
  writeTextFile(
    logPath,
    JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", module: "logSink", msg: "Session started" }) + "\n",
    { append: false, create: true },
  ).catch(() => {});

  // Attached now, before cleanup (below) runs — a slow directory scan must
  // never delay the sink, or an early failure (e.g. a transfer that fails
  // moments after launch) logs to the console only and never reaches disk.
  //
  // Debug-level lines never reach the file at all: http-handler alone logs
  // one per HTTP response, which drowns out the WARN/ERROR signal that
  // actually matters. Console still gets everything, for local dev.
  addLogSink((level, module, msg, args) => {
    if (level === "debug" || !logPath) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      module,
      msg,
      ...(args.length ? { args } : {}),
    }) + "\n";
    writeTextFile(logPath, line, { append: true }).catch(() => {});
  });

  void cleanup(dir).catch(() => {});
}
