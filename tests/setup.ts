import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

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
