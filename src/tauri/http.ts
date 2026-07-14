// The production fetch injected into createS3Client so S3 requests go through
// Rust (no browser CORS). Tests inject a mock or global fetch instead.
//
// Deliberately nothing but a re-export: tests/unit/support/realServicesHarness
// swaps this whole module out for a fake, so anything living here would be
// unreachable from a test. The implementation is in ./rawFetch, which nobody
// mocks and tests/unit/tauriHttp.test.ts exercises directly.

export { tauriFetch } from "./rawFetch";
