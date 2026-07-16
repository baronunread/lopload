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

// Keep debug/info log lines off the test console. The suite drives real HTTP
// against MinIO, and a printed line per request is enough terminal
// backpressure (when stdout is a TTY) to stall timers and fail waitFor-based
// assertions that pass when output is redirected to a file.
import { setConsoleLogLevel } from "../src/lib/logger";
setConsoleLogLevel("warn");

// jest-dom matchers on top of bun's expect
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

expect.extend(matchers as Parameters<typeof expect.extend>[0]);

// happy-dom never runs real layout, so every element's offsetHeight/offsetWidth
// is permanently 0. @tanstack/react-virtual reads those to size its scroll
// viewport, which would make it think there's no room to render any rows.
// Reporting a plausible viewport size here lets virtualized lists behave like
// they would in a real, laid-out window during tests.
const VIEWPORT_HEIGHT = 600;
const VIEWPORT_WIDTH = 800;
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return VIEWPORT_HEIGHT;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return VIEWPORT_WIDTH;
  },
});
