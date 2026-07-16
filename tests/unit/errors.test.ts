import { describe, expect, test } from "bun:test";
import { classifyError, describeThrown, plainMessageFor, toPlainError } from "../../src/lib/errors";
import type { ErrorClass } from "../../src/lib/types";

const ALL_CLASSES: ErrorClass[] = [
  "offline",
  "credentials",
  "storage-full",
  "connection-dropped",
  "verification",
  "not-found",
  "unknown",
];

describe("errors", () => {
  test("every ErrorClass has a plain sentence with no SDK/storage jargon", () => {
    for (const cls of ALL_CLASSES) {
      const msg = plainMessageFor(cls);
      expect(msg.length).toBeGreaterThan(0);
      const lower = msg.toLowerCase();
      for (const jargon of ["bucket", "object", "key", "etag", "multipart", "xml", "s3"]) {
        expect(lower).not.toContain(jargon);
      }
    }
  });

  test("offline sentence matches spec wording", () => {
    expect(plainMessageFor("offline")).toBe(
      "You're offline - we'll be ready when the connection is back.",
    );
  });

  test("403 http status classifies as credentials", () => {
    const err = { name: "SomeError", $metadata: { httpStatusCode: 403 } };
    expect(classifyError(err)).toBe("credentials");
  });

  test("401 http status classifies as credentials", () => {
    const err = { $metadata: { httpStatusCode: 401 } };
    expect(classifyError(err)).toBe("credentials");
  });

  test("AccessDenied / InvalidAccessKeyId codes classify as credentials", () => {
    expect(classifyError({ name: "AccessDenied" })).toBe("credentials");
    expect(classifyError({ name: "InvalidAccessKeyId" })).toBe("credentials");
    expect(classifyError({ name: "SignatureDoesNotMatch" })).toBe("credentials");
  });

  test("ECONNRESET / network error mid-part classifies as connection-dropped", () => {
    const err1 = new Error("socket hang up");
    (err1 as { code?: string }).code = "ECONNRESET";
    expect(classifyError(err1)).toBe("connection-dropped");

    const err2 = new Error("network error occurred mid-transfer");
    expect(classifyError(err2)).toBe("connection-dropped");
  });

  test("TypeError fetch failed / offline classifies as offline", () => {
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifyError(new TypeError("fetch failed"))).toBe("offline");
    expect(classifyError(new TypeError("Load failed"))).toBe("offline");
  });

  test("QuotaExceeded / 507 classifies as storage-full", () => {
    expect(classifyError({ name: "QuotaExceeded" })).toBe("storage-full");
    expect(classifyError({ $metadata: { httpStatusCode: 507 } })).toBe("storage-full");
  });

  test("NoSuchBucket / 404 classifies as not-found", () => {
    expect(classifyError({ name: "NoSuchBucket" })).toBe("not-found");
    expect(classifyError({ $metadata: { httpStatusCode: 404 } })).toBe("not-found");
  });

  test("unrecognized error falls back to unknown", () => {
    expect(classifyError({ name: "SomeWeirdThing" })).toBe("unknown");
    expect(classifyError(new Error("totally unexpected"))).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
  });

  test("5xx server errors classify as connection-dropped", () => {
    expect(classifyError({ $metadata: { httpStatusCode: 503 } })).toBe(
      "connection-dropped",
    );
  });

  test("toPlainError bundles class + message", () => {
    const result = toPlainError({ name: "NoSuchBucket" });
    expect(result).toEqual({
      errorClass: "not-found",
      message: plainMessageFor("not-found"),
    });
  });

  test("string throws classify via matching message-substring branches, not unknown", () => {
    expect(classifyError("socket hang up")).toBe("connection-dropped");
    expect(classifyError("you are offline")).toBe("offline");
  });

  test("arbitrary string throw with no matching branch classifies as unknown", () => {
    expect(classifyError("something totally arbitrary happened")).toBe("unknown");
  });

  test("describeThrown on an Error", () => {
    const result = describeThrown(new TypeError("bad stuff"));
    expect(result).toEqual({ message: "bad stuff", type: "Error", ctor: "TypeError" });
  });

  test("describeThrown on a raw string (tauri-plugin-http IPC rejection shape)", () => {
    const result = describeThrown("stream errored: connection reset");
    expect(result.message).toBe("stream errored: connection reset");
    expect(result.type).toBe("string");
    expect(result.ctor).toBe("String");
  });

  test("describeThrown on a plain object", () => {
    const result = describeThrown({ foo: "bar" });
    expect(result.type).toBe("object");
    expect(result.ctor).toBe("Object");
    expect(result.message).toBe("[object Object]");
  });

  test("describeThrown on null/undefined never throws", () => {
    expect(describeThrown(null)).toEqual({ message: "null", type: "object", ctor: null });
    expect(describeThrown(undefined)).toEqual({ message: "undefined", type: "undefined", ctor: null });
  });

  test("describeThrown truncates very long messages to 500 chars", () => {
    const long = "x".repeat(1000);
    const result = describeThrown(long);
    expect(result.message.length).toBe(500);
  });

  test("describeThrown enriches an S3-shaped error with status, code, and requestId", () => {
    // Modeled on the real shape of an AWS SDK v3 generated exception (e.g.
    // an actual NoSuchUpload seen in production logs): a named Error
    // subclass whose instance carries $metadata.
    class NoSuchUpload extends Error {
      $metadata: { httpStatusCode: number; requestId: string };
      constructor(message: string) {
        super(message);
        this.name = "NoSuchUpload";
        this.$metadata = { httpStatusCode: 404, requestId: "req-abc-123" };
      }
    }
    const err = new NoSuchUpload("The specified multipart upload does not exist.");
    const result = describeThrown(err);
    expect(result).toEqual({
      message: "The specified multipart upload does not exist.",
      type: "Error",
      ctor: "NoSuchUpload",
      status: 404,
      code: "NoSuchUpload",
      requestId: "req-abc-123",
    });
  });

  test("describeThrown on a plain S3-like object (no Error prototype) still surfaces status/code", () => {
    const err = { name: "AccessDenied", message: "Access Denied", $metadata: { httpStatusCode: 403 } };
    const result = describeThrown(err);
    expect(result.status).toBe(403);
    expect(result.code).toBe("AccessDenied");
    expect(result.requestId).toBeUndefined();
  });

  test("describeThrown omits status/code/requestId entirely for a plain Error (no extra keys)", () => {
    const result = describeThrown(new TypeError("bad stuff"));
    expect(Object.keys(result).sort()).toEqual(["ctor", "message", "type"]);
  });
});
