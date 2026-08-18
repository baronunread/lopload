import { describe, expect, test } from "bun:test";
import type { HttpRequest } from "@smithy/core/protocols";
import { InjectedFetchHttpHandler } from "../../src/lib/s3/http-handler";
import { addLogSink, type LogLevel } from "../../src/lib/logger";

function baseRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  // SAFETY: this fixture supplies all fields needed by the default request.
  // Optional fields remain undefined unless a test provides an override.
  return {
    protocol: "https:",
    hostname: "s3.example.com",
    port: undefined,
    path: "/bucket/key",
    query: {},
    headers: {},
    method: "GET",
    ...overrides,
  } as HttpRequest;
}

interface CapturedLogLine {
  level: LogLevel;
  module: string;
  msg: string;
}

interface CapturedLogs {
  lines: CapturedLogLine[];
}

function captureLogs(): CapturedLogs {
  const lines: CapturedLogLine[] = [];
  addLogSink((level, module, msg) => {
    if (module === "http-handler") lines.push({ level, module, msg });
  });
  return { lines };
}

describe("s3/http-handler response logging", () => {
  test("a 2xx response logs at debug, not warn", async () => {
    const { lines } = captureLogs();
    const handler = new InjectedFetchHttpHandler(
      async () => new Response(new Blob([]), { status: 200 }),
    );
    await handler.handle(baseRequest());
    const responseLines = lines.filter((l) => l.msg === "response");
    expect(responseLines).toHaveLength(1);
    expect(responseLines[0].level).toBe("debug");
  });

  test("a non-2xx response is escalated to warn, so it survives the file sink's debug filter", async () => {
    const { lines } = captureLogs();
    const handler = new InjectedFetchHttpHandler(
      async () => new Response(new Blob([]), { status: 403 }),
    );
    await handler.handle(baseRequest());
    const responseLines = lines.filter((l) => l.msg === "response");
    expect(responseLines).toHaveLength(1);
    expect(responseLines[0].level).toBe("warn");
  });
});
