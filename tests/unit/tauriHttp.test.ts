import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createTauriFetch, type TauriFetchDeps } from "../../src/tauri/http";

type InvokeOptions = { headers: Record<string, string> };

const OK_REPLY = { status: 200, statusText: "OK", headers: [["etag", '"abc123"']], body: [] };

// Injected rather than mock.module'd: bun's module mocks are process-wide and
// would put this test at the mercy of file ordering across the whole suite.
const invoke = mock(
  async (_cmd: string, _payload?: unknown, _options?: InvokeOptions): Promise<unknown> => OK_REPLY,
);
const pluginFetch = mock(async (): Promise<Response> => new Response("from plugin-http"));

const tauriFetch = createTauriFetch({
  invoke,
  fetch: pluginFetch as unknown as TauriFetchDeps["fetch"],
});

function lastCall(cmd: string): [string, unknown, InvokeOptions] | undefined {
  return invoke.mock.calls.findLast((call) => call[0] === cmd) as
    | [string, unknown, InvokeOptions]
    | undefined;
}

describe("tauri/http", () => {
  beforeEach(() => {
    invoke.mockClear();
    pluginFetch.mockClear();
    invoke.mockImplementation(async () => OK_REPLY);
  });

  test("an UploadPart body crosses the IPC as the raw payload, not through plugin-http", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const url = "https://s3.example.com/bucket/my résumé.pdf?partNumber=2";

    const response = await tauriFetch(url, {
      method: "PUT",
      body,
      headers: { authorization: "AWS4-HMAC-SHA256 Credential=abc" },
    });

    // plugin-http would have JSON-stringified these bytes into decimal text.
    expect(pluginFetch).not.toHaveBeenCalled();

    const call = lastCall("http_send");
    expect(call).toBeDefined();
    const [, payload, options] = call!;
    // The bytes must *be* the payload — that's the only shape Tauri sends raw.
    expect(payload).toBe(body);
    expect(options.headers["x-method"]).toBe("PUT");
    expect(decodeURIComponent(options.headers["x-url"])).toBe(url);
    expect(JSON.parse(decodeURIComponent(options.headers["x-headers"]))).toContainEqual([
      "authorization",
      "AWS4-HMAC-SHA256 Credential=abc",
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"abc123"');
  });

  test("S3's error XML comes back as a readable response body", async () => {
    const xml = "<Error><Code>AccessDenied</Code></Error>";
    invoke.mockImplementation(async () => ({
      status: 403,
      statusText: "Forbidden",
      headers: [],
      body: Array.from(new TextEncoder().encode(xml)),
    }));

    const response = await tauriFetch("https://s3.example.com/bucket/k", {
      method: "PUT",
      body: new Uint8Array([9]),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe(xml);
  });

  test("requests without bytes to send stay on plugin-http", async () => {
    await tauriFetch("https://s3.example.com/bucket?list-type=2", { method: "GET" });
    // CompleteMultipartUpload and friends: a small XML string, not a byte body.
    await tauriFetch("https://s3.example.com/bucket/k?uploadId=1", {
      method: "POST",
      body: "<CompleteMultipartUpload />",
    });

    expect(pluginFetch).toHaveBeenCalledTimes(2);
    expect(lastCall("http_send")).toBeUndefined();
  });

  test("a zero-byte body stays on plugin-http", async () => {
    // Folder markers (createFolder, the trash-folder marker) PUT an empty
    // Uint8Array. The fast path's reqwest sends no content-length header for
    // an empty body while SigV4 signed `content-length: 0`, so R2 rejects the
    // request with SignatureDoesNotMatch — and there are no bytes to keep off
    // the IPC serializer anyway.
    await tauriFetch("https://s3.example.com/bucket/folder/", {
      method: "PUT",
      body: new Uint8Array(0),
    });
    await tauriFetch("https://s3.example.com/bucket/folder2/", {
      method: "PUT",
      body: new ArrayBuffer(0),
    });

    expect(pluginFetch).toHaveBeenCalledTimes(2);
    expect(lastCall("http_send")).toBeUndefined();
  });

  test("aborting mid-part cancels the send in Rust and rejects as an AbortError", async () => {
    // Stand in for the Rust command: http_send hangs until http_cancel fires,
    // then rejects the way a cancelled send does.
    let failSend: ((err: Error) => void) | undefined;
    invoke.mockImplementation(async (cmd, payload) => {
      if (cmd === "http_send") {
        return new Promise((_resolve, reject) => {
          failSend = reject;
        });
      }
      expect(cmd).toBe("http_cancel");
      // Rust keys its cancel registry by the id the send announced.
      const sent = lastCall("http_send");
      expect((payload as { id: number }).id).toBe(Number(sent![2].headers["x-request-id"]));
      failSend?.(new Error("http_send: request cancelled"));
      return undefined;
    });

    const controller = new AbortController();
    const pending = tauriFetch("https://s3.example.com/bucket/k", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }) as unknown as Error,
    );
    expect(lastCall("http_cancel")).toBeDefined();
  });

  test("a signal that is already aborted never reaches the IPC", async () => {
    const pending = tauriFetch("https://s3.example.com/bucket/k", {
      method: "PUT",
      body: new Uint8Array([1]),
      signal: AbortSignal.abort(),
    });

    await expect(pending).rejects.toThrow(
      expect.objectContaining({ name: "AbortError" }) as unknown as Error,
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
