import { describe, expect, test } from "bun:test";

import { mapWithConcurrency } from "../../src/lib/concurrency";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapWithConcurrency", () => {
  test("runs every item and returns results in input order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return n;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("fails fast: a rejection stops new work from starting and propagates", async () => {
    const started: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        started.push(n);
        if (n === 3) throw new Error("boom");
        await sleep(10);
        return n;
      }),
    ).rejects.toThrow("boom");

    // Only a couple of workers get to run past the failing item before the
    // pool notices `failed` and stops handing out new work — nowhere near
    // the full 8.
    expect(started.length).toBeLessThan(items.length);
  });

  test("handles an empty item list", async () => {
    const results = await mapWithConcurrency([], 4, async (n: number) => n);
    expect(results).toEqual([]);
  });

  test("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 100, async (n) => n);
    expect(results).toEqual([1, 2]);
  });
});
