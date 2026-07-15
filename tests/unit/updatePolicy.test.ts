import { describe, expect, test } from "bun:test";
import {
  buildUpdateBanner,
  downloadPercent,
  shouldCheckForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
} from "../../src/lib/updatePolicy";

describe("shouldCheckForUpdate", () => {
  test("always checks on first run (no prior check recorded)", () => {
    expect(shouldCheckForUpdate(Date.now(), null)).toBe(true);
  });

  test("doesn't recheck before the interval has elapsed", () => {
    const lastCheckedAt = 1_000_000;
    const now = lastCheckedAt + UPDATE_CHECK_INTERVAL_MS - 1;
    expect(shouldCheckForUpdate(now, lastCheckedAt)).toBe(false);
  });

  test("rechecks once the interval has fully elapsed", () => {
    const lastCheckedAt = 1_000_000;
    const now = lastCheckedAt + UPDATE_CHECK_INTERVAL_MS;
    expect(shouldCheckForUpdate(now, lastCheckedAt)).toBe(true);
  });
});

describe("downloadPercent", () => {
  test("reads as 0 when the total isn't known yet", () => {
    expect(downloadPercent(1234, null)).toBe(0);
    expect(downloadPercent(1234, 0)).toBe(0);
  });

  test("rounds bytes to a whole percent", () => {
    expect(downloadPercent(50, 100)).toBe(50);
    expect(downloadPercent(1, 3)).toBe(33);
  });

  test("clamps to 0–100 even if more bytes than expected arrive", () => {
    expect(downloadPercent(-5, 100)).toBe(0);
    expect(downloadPercent(150, 100)).toBe(100);
  });
});

describe("buildUpdateBanner", () => {
  test("available phase offers the Update action", () => {
    const banner = buildUpdateBanner("available", "9.9.9", false);
    expect(banner.title).toContain("9.9.9");
    expect(banner.actionLabel).toBe("Update");
  });

  test("downloading phase shows percent and no action", () => {
    const banner = buildUpdateBanner("downloading", "9.9.9", false, 42);
    expect(banner.body).toContain("42");
    expect(banner.actionLabel).toBeNull();
  });

  test("ready phase offers a restart, plainly when nothing is transferring", () => {
    const banner = buildUpdateBanner("ready", "9.9.9", false);
    expect(banner.body.toLowerCase()).toContain("restart");
    expect(banner.body.toLowerCase()).not.toContain("transfer");
    expect(banner.actionLabel).toBe("Restart now");
  });

  test("ready phase warns about in-flight transfers without hiding the restart", () => {
    const banner = buildUpdateBanner("ready", "9.9.9", true);
    expect(banner.body.toLowerCase()).toContain("transfers");
    expect(banner.body.toLowerCase()).toMatch(/interrupt|failed/);
    expect(banner.actionLabel).toBe("Restart now");
  });
});
