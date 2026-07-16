// A `FetchHttpHandler`-shaped requestHandler for @aws-sdk/client-s3 whose
// underlying `fetch` is injected. This is the CORS-bypass seam from
// PLAN.md #2: in the app the injected fetch is @tauri-apps/plugin-http's
// fetch (goes through Rust, no browser CORS); in tests it's a mock or
// global fetch. @smithy/fetch-http-handler always calls the *global*
// `fetch`, so we reimplement its (small) request/response translation here
// instead of subclassing it.

import {
  buildQueryString,
  HttpResponse,
  type HttpHandler,
  type HttpRequest,
} from "@smithy/core/protocols";
import type { FetchHttpHandlerOptions, HttpHandlerOptions } from "@smithy/types";
import { createLogger } from "../logger";

const log = createLogger("http-handler");

/** Matches the global `fetch` signature; @tauri-apps/plugin-http's fetch is compatible. */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function buildAbortError(abortSignal?: AbortSignal): Error {
  const reason =
    abortSignal && typeof abortSignal === "object" && "reason" in abortSignal
      ? (abortSignal as { reason?: unknown }).reason
      : undefined;
  if (reason instanceof Error) {
    const abortError = new Error("Request aborted");
    abortError.name = "AbortError";
    (abortError as { cause?: unknown }).cause = reason;
    return abortError;
  }
  const abortError = new Error("Request aborted");
  abortError.name = "AbortError";
  return abortError;
}

function requestTimeout(timeoutInMs = 0): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (timeoutInMs) {
      setTimeout(() => {
        const err = new Error(`Request did not complete within ${timeoutInMs} ms`);
        err.name = "TimeoutError";
        reject(err);
      }, timeoutInMs);
    }
  });
}

/** requestHandler for S3Client that routes every call through an injected fetch. */
export class InjectedFetchHttpHandler
  implements HttpHandler<FetchHttpHandlerOptions>
{
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly config: FetchHttpHandlerOptions = {},
  ) {}

  destroy(): void {}

  async handle(
    request: HttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    // @smithy/types unions AbortSignal with a deprecated internal interface
    // of the same shape; at runtime it's always the real platform AbortSignal.
    const abortSignal = options.abortSignal as AbortSignal | undefined;
    const requestTimeoutMs = options.requestTimeout;
    if (abortSignal?.aborted) {
      throw buildAbortError(abortSignal);
    }

    let path = request.path;
    const queryString = buildQueryString(request.query || {});
    if (queryString) path += `?${queryString}`;
    if (request.fragment) path += `#${request.fragment}`;

    let auth = "";
    if (request.username != null || request.password != null) {
      auth = `${request.username ?? ""}:${request.password ?? ""}@`;
    }

    const { port, method } = request;
    const url = `${request.protocol}//${auth}${request.hostname}${
      port ? `:${port}` : ""
    }${path}`;

    const body = method === "GET" || method === "HEAD" ? undefined : request.body;
    // SigV4 signs a `host` header, but fetch forbids setting it manually —
    // the transport derives Host from the URL, which matches the signed
    // value. Drop it here so tauri-plugin-http doesn't warn on every call.
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    const requestInit: RequestInit = {
      body,
      headers,
      method,
    };
    if (abortSignal) {
      requestInit.signal = abortSignal;
    }

    const timeoutMs = requestTimeoutMs ?? this.config.requestTimeout;

    const doFetch = this.fetchFn(url, requestInit).then(async (response) => {
      const transformedHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        transformedHeaders[key] = value;
      });
      const hasReadableStream = response.body != undefined;
      // Every successful response logs at debug (the file sink drops debug
      // entirely — see logSink.ts — so this only ever shows up in the
      // console during local dev). A non-2xx response is signal, not noise:
      // it's the first indication of a request that's about to surface as a
      // classified failure, so it's worth keeping in the file at warn.
      if (response.status >= 400) {
        log.warn("response", method, url, { status: response.status, hasReadableStream });
      } else {
        log.debug("response", url, { status: response.status, hasReadableStream });
      }
      if (!hasReadableStream) {
        const blob = await response.blob();
        log.debug("response body consumed as Blob", { size: blob.size });
        return {
          response: new HttpResponse({
            headers: transformedHeaders,
            reason: response.statusText,
            statusCode: response.status,
            body: blob,
          }),
        };
      }
      return {
        response: new HttpResponse({
          headers: transformedHeaders,
          reason: response.statusText,
          statusCode: response.status,
          body: response.body,
        }),
      };
    });

    return Promise.race([doFetch, requestTimeout(timeoutMs)]);
  }

  updateHttpClientConfig(
    key: keyof FetchHttpHandlerOptions,
    value: FetchHttpHandlerOptions[typeof key],
  ): void {
    (this.config as Record<string, unknown>)[key] = value;
  }

  httpHandlerConfigs(): FetchHttpHandlerOptions {
    return this.config;
  }
}
