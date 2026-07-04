// Classifies arbitrary thrown errors (AWS SDK errors, fetch failures, HTTP
// status codes) into the ErrorClass taxonomy and produces a PlainError with
// exactly one plain-language sentence. Nothing here may leak SDK text, XML,
// or storage jargon (bucket/object/key/ETag/multipart) to callers — the UI
// renders `PlainError.message` verbatim.

import type { ErrorClass, PlainError } from "./types";

const MESSAGES: Record<ErrorClass, string> = {
  offline:
    "You're offline — we'll be ready when the connection is back.",
  credentials:
    "Your credentials were rejected — please check them and try again.",
  "storage-full":
    "There's no storage space left — free up some room and try again.",
  "connection-dropped":
    "The connection dropped partway through — we'll pick up where it left off.",
  verification:
    "We couldn't confirm the file arrived intact, so it hasn't been marked as sent.",
  "not-found":
    "That item couldn't be found — it may have been moved or deleted.",
  unknown: "Something went wrong — please try again.",
};

export function plainMessageFor(errorClass: ErrorClass): string {
  return MESSAGES[errorClass];
}

/** Shape AWS SDK v3 errors expose for HTTP status + error code. */
interface SdkLikeError {
  name?: string;
  Code?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

function httpStatusOf(err: SdkLikeError): number | undefined {
  return err.$metadata?.httpStatusCode;
}

function codeOf(err: SdkLikeError): string | undefined {
  return err.name ?? err.Code ?? err.code;
}

const CREDENTIALS_CODES = new Set([
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "InvalidClientTokenId",
  "AuthorizationHeaderMalformed",
  "CredentialsProviderError",
  "ExpiredToken",
]);

const NOT_FOUND_CODES = new Set([
  "NoSuchBucket",
  "NoSuchKey",
  "NotFound",
  "NoSuchUpload",
]);

const STORAGE_FULL_CODES = new Set([
  "QuotaExceeded",
  "ServiceQuotaExceededException",
  "EntityTooLarge",
  "InsufficientStorage",
]);

const CONNECTION_DROPPED_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "RequestTimeout",
  "TimeoutError",
]);

/**
 * Classify an arbitrary caught error into an ErrorClass. Order matters:
 * network-shape checks first (they can appear on plain Error/TypeError with
 * no $metadata), then HTTP status, then SDK error codes, then a fallback.
 */
export function classifyError(err: unknown): ErrorClass {
  if (err == null) return "unknown";

  // Browser/runtime fetch failures: TypeError("Failed to fetch") / "fetch
  // failed" / "Load failed" (Safari) with no network at all reads as offline.
  if (err instanceof TypeError) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("failed to fetch") ||
      msg.includes("fetch failed") ||
      msg.includes("load failed") ||
      msg.includes("network")
    ) {
      return "offline";
    }
  }

  const e = err as SdkLikeError;
  const code = codeOf(e);
  const msg = (e.message ?? "").toLowerCase();

  if (code && CONNECTION_DROPPED_CODES.has(code)) return "connection-dropped";
  if (
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("aborted")
  ) {
    return "connection-dropped";
  }

  if (
    msg.includes("offline") ||
    msg.includes("no internet") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again")
  ) {
    return "offline";
  }

  const status = httpStatusOf(e);

  if (code && CREDENTIALS_CODES.has(code)) return "credentials";
  if (status === 401 || status === 403) return "credentials";

  if (code && NOT_FOUND_CODES.has(code)) return "not-found";
  if (status === 404) return "not-found";

  if (code && STORAGE_FULL_CODES.has(code)) return "storage-full";
  if (status === 507) return "storage-full";

  if (status !== undefined && status >= 500) return "connection-dropped";

  return "unknown";
}

/** Classify and produce the full PlainError (class + one sentence). */
export function toPlainError(err: unknown): PlainError {
  const errorClass = classifyError(err);
  return { errorClass, message: plainMessageFor(errorClass) };
}
