export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

function log(level: LogLevel, module: string, msg: string, args: unknown[]) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${module}] ${msg}${args.length ? " " + JSON.stringify(args) : ""}`;
  switch (level) {
    case "debug": console.debug(line); break;
    case "info": console.info(line); break;
    case "warn": console.warn(line); break;
    case "error": console.error(line); break;
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
