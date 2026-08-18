import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun's real fetch, captured before happy-dom replaces globalThis.fetch with
// its browser-shaped one. That substitute enforces CORS, so the AWS SDK
// running on top of it sends a preflight OPTIONS that S3 endpoints reject —
// which is what made the old `test:e2e` suite fail against R2 regardless of
// what it was testing. The Node host (tests/support/nodeHost.ts) hands this
// binding to the S3 client so tests reach real storage over real HTTP, while
// the DOM the UI renders into stays happy-dom's.
export const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

GlobalRegistrator.register();
