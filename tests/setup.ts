// Registers happy-dom's `document` first, via its own preload file (see
// bunfig.toml) — jest-dom's matchers module below pulls in @testing-library/dom
// as a plain (non-lazy) import, which snapshots `document` the moment it's
// required. Static imports in this file are hoisted above any statement here,
// so calling GlobalRegistrator.register() in this same file, even textually
// first, would still lose that race against the matchers import.
export { nativeFetch } from "./domSetup";

// Keep debug/info log lines off the test console. The suite drives real HTTP
// against MinIO, and a printed line per request is enough terminal
// backpressure (when stdout is a TTY) to stall timers and fail waitFor-based
// assertions that pass when output is redirected to a file.
import { setConsoleLogLevel } from "../src/lib/logger";
setConsoleLogLevel("warn");

// jest-dom matchers on top of bun's expect
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

// SAFETY: @testing-library/jest-dom's matchers are written against Jest's
// expect.extend shape, which bun:test's is deliberately compatible with at
// runtime even though the two packages' types don't structurally align.
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
