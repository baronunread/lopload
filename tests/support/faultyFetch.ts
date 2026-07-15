// Fault injection at the wire, against a real bucket.
//
// The only thing a fake S3 could do that a real one can't is misbehave on
// demand — deny a request, stall long enough for a cancel to land, hand back a
// corrupt ETag. That's what the old in-memory fake bucket was really for, and
// it's the one capability worth keeping.
//
// So keep the capability and drop the fake: wrap the FetchFn that
// createS3Client already takes, and let a rule answer a matching request
// instead of MinIO. Everything unmatched goes to real storage. The upshot is
// that error-path tests exercise the app's real error handling against genuine
// S3 error XML — the thing an in-memory fake could only approximate.
import type { FetchFn } from "../../src/lib/s3/http-handler";

export interface Fault {
  /** Applies to requests whose URL contains this substring (typically a key). */
  urlContains: string;
  /** Only fault this HTTP method — handy when a key must upload but not download. */
  method?: string;
  /** Fault only the first N matching requests, then let the rest through. */
  times?: number;
  /** What the fault does. */
  action: FaultAction;
}

export type FaultAction =
  /** Reply with a genuine S3 error document, so classifyError() sees real XML. */
  | { kind: "s3Error"; status: number; code: string; message: string }
  /** Wait before passing the request through — a window for a cancel to land. */
  | { kind: "stall"; ms: number }
  /** Fail the way a dropped connection does: reject, no response at all. */
  | { kind: "networkError"; message?: string }
  /** Pass through, but rewrite the ETag so verification must reject the body. */
  | { kind: "corruptEtag" }
  /** Pass through, but truncate the body so the byte count can't match. */
  | { kind: "truncateBody"; bytes: number };

function s3ErrorBody(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>faultyFetch</RequestId></Error>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wraps a FetchFn so matching requests hit a fault instead of the network.
 * Faults are consumed in order; a rule with `times` set stops applying once
 * it's been used that many times.
 */
export function faultyFetch(inner: FetchFn, faults: Fault[]): FetchFn {
  const remaining = new Map<Fault, number>(
    faults.map((f) => [f, f.times ?? Number.POSITIVE_INFINITY]),
  );

  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();

    const fault = faults.find((f) => {
      if ((remaining.get(f) ?? 0) <= 0) return false;
      if (!url.includes(f.urlContains)) return false;
      if (f.method && f.method.toUpperCase() !== method) return false;
      return true;
    });

    if (!fault) return inner(input, init);
    remaining.set(fault, (remaining.get(fault) ?? 0) - 1);

    const { action } = fault;
    switch (action.kind) {
      case "s3Error":
        return new Response(s3ErrorBody(action.code, action.message), {
          status: action.status,
          headers: { "content-type": "application/xml" },
        });

      case "networkError":
        throw new TypeError(action.message ?? "network went away");

      case "stall":
        await sleep(action.ms);
        return inner(input, init);

      case "corruptEtag": {
        const res = await inner(input, init);
        const headers = new Headers(res.headers);
        headers.set("etag", '"00000000000000000000000000000000"');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }

      case "truncateBody": {
        const res = await inner(input, init);
        const body = new Uint8Array(await res.arrayBuffer());
        return new Response(body.subarray(0, action.bytes), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
    }
  };
}
