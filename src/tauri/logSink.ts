import { appLogDir } from "@tauri-apps/api/path";
import { writeTextFile, mkdir, readDir, remove, stat } from "@tauri-apps/plugin-fs";
import { addLogSink } from "../lib/logger";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FILES = 20;

let logPath: string | null = null;

function fileSafeISODate(): string {
  const n = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}-${pad(n.getMinutes())}-${pad(n.getSeconds())}`;
}

interface LogEntry {
  name: string;
  mtime: number;
}

async function listSessionLogs(dir: string): Promise<LogEntry[]> {
  const files = await readDir(dir).catch<[]>(() => []);
  const names = files
    .filter((f) => !f.isDirectory && f.name?.startsWith("lopload-") && f.name.endsWith(".log"))
    .map((f) => f.name!)
    .sort();

  const entries: LogEntry[] = [];
  for (const name of names) {
    const s = await stat(`${dir}/${name}`).catch(() => null);
    if (s) entries.push({ name, mtime: +(s.mtime ?? 0) });
  }
  return entries;
}

async function cleanup(dir: string): Promise<void> {
  const sessions = await listSessionLogs(dir);
  sessions.sort((a, b) => b.mtime - a.mtime);

  const candidates = sessions.slice(MAX_FILES);
  const threshold = Date.now() - SESSION_TTL_MS;
  await Promise.all(
    candidates
      .filter((f) => f.mtime < threshold)
      .map((f) => remove(`${dir}/${f.name}`).catch(() => {})),
  );
}

export async function initFileLogSink(): Promise<void> {
  try {
    const dir = await appLogDir();
    await mkdir(dir, { recursive: true });
    await cleanup(dir);
    logPath = `${dir}/lopload-${fileSafeISODate()}.log`;
    writeTextFile(
      logPath,
      JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", module: "logSink", msg: "Session started" }) + "\n",
      { append: false, create: true },
    ).catch(() => {});
  } catch {
    return;
  }

  addLogSink((level, module, msg, args) => {
    if (!logPath) return;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      module,
      msg,
      ...(args.length ? { args } : {}),
    }) + "\n";
    writeTextFile(logPath, line, { append: true }).catch(() => {});
  });
}
