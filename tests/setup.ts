import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// jest-dom matchers on top of bun's expect
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "bun:test";

expect.extend(matchers as Parameters<typeof expect.extend>[0]);
