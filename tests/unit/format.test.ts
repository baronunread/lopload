import { describe, expect, test } from "bun:test";
import { formatDate } from "../../src/ui/format";

describe("formatDate", () => {
  test("returns the placeholder when no timestamp is given", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  // 2026-07-16T12:00:00Z — a date whose day (16) and month (07) are both
  // valid values for either slot, so a wrong day/month order is visible.
  const ms = Date.UTC(2026, 6, 16, 12, 0, 0);

  test("renders numeric day/month/year for an EU locale, no month names", () => {
    expect(formatDate(ms, "it-IT")).toBe("16/07/2026");
  });

  test("renders numeric month/day/year for a US locale, no month names", () => {
    expect(formatDate(ms, "en-US")).toBe("07/16/2026");
  });
});
