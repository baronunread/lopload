import { describe, expect, test } from "bun:test";
import { classifyError, plainMessageFor, toPlainError } from "../../src/lib/errors";
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
});
