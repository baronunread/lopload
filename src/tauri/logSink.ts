import { appLogDir } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { addLogSink, type LogLevel } from "../lib/logger";

let logPath: string | null = null;

function formatLine(_level: LogLevel, _module: string, line: string): string {
  return line + "\n";
}

export async function initFileLogSink(): Promise<void> {
  const dir = await appLogDir();
  logPath = `${dir}/lopload.log`;

  try {
    await writeTextFile(logPath, "", { append: false, create: true });
  } catch {
    return;
  }

  addLogSink((level, module, line) => {
    if (!logPath) return;
    const text = formatLine(level, module, line);
    writeTextFile(logPath, text, { append: true }).catch(() => {});
  });
}
