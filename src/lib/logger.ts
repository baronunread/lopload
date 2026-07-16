export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export type LogSink = (level: LogLevel, module: string, msg: string, args: unknown[]) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Below this level, lines skip the console but still reach every sink (the
// file log keeps full detail). Tests raise it to "warn": the suite makes
// thousands of HTTP requests, and printing a debug line per request to a TTY
// stalls the event loop enough to time out real waitFor-based assertions.
let consoleLevel: LogLevel = "debug";

export function setConsoleLogLevel(level: LogLevel): void {
  consoleLevel = level;
}

let extraSinks: LogSink[] = [];

export function addLogSink(sink: LogSink): void {
  extraSinks.push(sink);
}

function log(level: LogLevel, module: string, msg: string, args: unknown[]) {
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[consoleLevel]) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] [${module}] ${msg}${args.length ? " " + JSON.stringify(args) : ""}`;
    switch (level) {
      case "debug": console.debug(line); break;
      case "info": console.info(line); break;
      case "warn": console.warn(line); break;
      case "error": console.error(line); break;
    }
  }
  for (const sink of extraSinks) {
    try {
      sink(level, module, msg, args);
    } catch {
      // Sink failures must never break logging.
    }
  }
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg: string, ...args: unknown[]) => log("debug", module, msg, args),
    info: (msg: string, ...args: unknown[]) => log("info", module, msg, args),
    warn: (msg: string, ...args: unknown[]) => log("warn", module, msg, args),
    error: (msg: string, ...args: unknown[]) => log("error", module, msg, args),
  };
}
