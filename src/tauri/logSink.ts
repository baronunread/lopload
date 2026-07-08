import { appLogDir } from "@tauri-apps/api/path";
import { writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { addLogSink, type LogLevel } from "../lib/logger";

let logPath: string | null = null;

function formatLine(_level: LogLevel, _module: string, line: string): string {
  return line + "\n";
}

export async function initFileLogSink(): Promise<void> {
  try {
    const dir = await appLogDir();
    await mkdir(dir, { recursive: true });
    logPath = `${dir}/lopload.log`;
    const header = `[${new Date().toISOString()}] [INFO] [logSink] Log file initialized\n`;
    await writeTextFile(logPath, header, { append: false, create: true });
  } catch {
    return;
  }

  addLogSink((level, module, line) => {
    if (!logPath) return;
    const text = formatLine(level, module, line);
    writeTextFile(logPath, text, { append: true }).catch(() => {});
  });
}
