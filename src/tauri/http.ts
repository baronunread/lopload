// The production fetch injected into createS3Client so S3 requests go through
// Rust (no browser CORS). Tests inject a mock or global fetch instead.
//
// Requests that carry bytes — PutObject and UploadPart, i.e. every upload —
// deliberately bypass @tauri-apps/plugin-http. Its fetch() runs the body
// through `Array.from(new Uint8Array(buffer))` and passes it nested inside its
// args object, which Tauri's IPC serializer JSON-stringifies: an 8 MiB part
// leaves the webview as ~30 MB of decimal text and pins the UI thread, which is
// why a running upload made the app crawl. It's the same trap the download path
// hit on the way out (see src-tauri/src/fastfs.rs) — Tauri only takes its
// raw-bytes path when the payload *is* the TypedArray. So those requests go to
// our own `http_send` command (src-tauri/src/fasthttp.rs) with the body as the
// whole payload and the method/URL/headers as IPC headers.
//
// Everything else — no body, or the small XML string bodies of
// CompleteMultipartUpload and friends — stays on plugin-http, which handles
// them at a size where the serializer's shape doesn't matter.

import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { fetch as pluginFetch } from "@tauri-apps/plugin-http";

import type { FetchFn } from "../lib/s3/http-handler";

/** `http_send`'s reply (src-tauri/src/fasthttp.rs). */
interface Reply {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: number[];
}

/** The two Tauri entry points this module needs, injected rather than imported
 * so tests can drive it without bun's process-wide `mock.module` — see
 * tests/unit/tauriHttp.test.ts. */
export interface TauriFetchDeps {
  invoke: (cmd: string, payload?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;
  /** plugin-http's fetch, for every request without a byte body to send. */
  fetch: FetchFn;
}

// Only has to be unique among the sends this webview has in flight: Rust keys
// its cancel registry by it.
let nextRequestId = 1;

function abortError(): Error {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

function byteBody(body: BodyInit | null | undefined): Uint8Array | undefined {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

async function sendBytes(
  deps: TauriFetchDeps,
  url: string,
  init: RequestInit,
  body: Uint8Array,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortError();

  const headers: [string, string][] = [];
  new Headers(init.headers).forEach((value, name) => headers.push([name, value]));

  const id = nextRequestId++;
  // Nothing to do if the cancel itself fails (the app is quitting, say) — the
  // send below is already rejecting, and an unhandled rejection here would just
  // be noise.
  const cancel = () => void deps.invoke("http_cancel", { id }).catch(() => {});
  signal?.addEventListener("abort", cancel);
  try {
    // The body is the entire invoke argument (Tauri's raw-bytes path); the rest
    // of the request rides along as headers, percent-encoded because HTTP
    // headers are ASCII-only and URLs and signatures are not.
    const reply = (await deps.invoke("http_send", body, {
      headers: {
        "x-request-id": String(id),
        "x-method": init.method ?? "PUT",
        "x-url": encodeURIComponent(url),
        "x-headers": encodeURIComponent(JSON.stringify(headers)),
      },
    })) as Reply;
    return new Response(reply.body.length > 0 ? new Uint8Array(reply.body) : null, {
      status: reply.status,
      statusText: reply.statusText,
      headers: reply.headers,
    });
  } catch (err) {
    // A cancelled send rejects with whatever Rust said; the caller (the
    // transfer engine, pausing) is asking about its own signal.
    if (signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function createTauriFetch(deps: TauriFetchDeps): FetchFn {
  return async (input, init) => {
    const body = init ? byteBody(init.body) : undefined;
    // A Request argument carries its own body, which we'd have to drain to see
    // it; the S3 handler never passes one, so leave that case to plugin-http.
    if (init && body && !(input instanceof Request)) {
      return sendBytes(deps, input.toString(), init, body);
    }
    return deps.fetch(input, init);
  };
}

export const tauriFetch = createTauriFetch({ invoke, fetch: pluginFetch });
