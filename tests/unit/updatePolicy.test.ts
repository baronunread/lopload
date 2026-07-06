import { describe, expect, test } from "bun:test";
import {
  buildUpdateNotice,
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

describe("buildUpdateNotice", () => {
  test("plain restart notice when nothing is transferring", () => {
    const notice = buildUpdateNotice(false);
    expect(notice.title).toBe("A new version is ready");
    expect(notice.body.toLowerCase()).toContain("restart");
    expect(notice.body.toLowerCase()).not.toContain("transfer");
    expect(notice.actionLabel).toBe("Restart and update");
  });

  test("reassures about in-flight transfers resuming, without blocking the action", () => {
    const notice = buildUpdateNotice(true);
    expect(notice.body.toLowerCase()).toContain("transfers");
    expect(notice.body.toLowerCase()).toMatch(/pick up|resum/);
    expect(notice.actionLabel).toBe("Restart and update");
  });
});
