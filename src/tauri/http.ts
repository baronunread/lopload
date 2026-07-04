// Re-exports @tauri-apps/plugin-http's fetch — the production fetch
// implementation injected into createS3Client so S3 requests go through
// Rust (no browser CORS). Tests inject a mock or global fetch instead.

export { fetch as tauriFetch } from "@tauri-apps/plugin-http";
