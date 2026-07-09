import { describe, expect, test } from "bun:test";

import { DEFAULT_TUNING, PRESETS, presetMatching } from "../../src/lib/tuning";

describe("transfer tuning presets", () => {
  test("PRESETS table matches the plan's Slow/Normal/Fast knob values", () => {
    expect(PRESETS.slow).toEqual({
      preset: "slow",
      concurrentFiles: 1,
      uploadPartsInFlight: 2,
      downloadConnections: 2,
      partSizeMiB: 8,
    });
    expect(PRESETS.normal).toEqual({
      preset: "normal",
      concurrentFiles: 3,
      uploadPartsInFlight: 4,
      downloadConnections: 4,
      partSizeMiB: 8,
    });
    expect(PRESETS.fast).toEqual({
      preset: "fast",
      concurrentFiles: 4,
      uploadPartsInFlight: 8,
      downloadConnections: 8,
      partSizeMiB: 8,
    });
  });

  test("DEFAULT_TUNING is Normal", () => {
    expect(DEFAULT_TUNING).toEqual(PRESETS.normal);
  });

  test("presetMatching recognizes each exact preset's knobs", () => {
    expect(presetMatching(PRESETS.slow)).toBe("slow");
    expect(presetMatching(PRESETS.normal)).toBe("normal");
    expect(presetMatching(PRESETS.fast)).toBe("fast");
  });

  test("presetMatching returns custom for a knob set matching no preset", () => {
    expect(
      presetMatching({
        concurrentFiles: 2,
        uploadPartsInFlight: 4,
        downloadConnections: 4,
        partSizeMiB: 8,
      }),
    ).toBe("custom");

    expect(
      presetMatching({
        concurrentFiles: 3,
        uploadPartsInFlight: 4,
        downloadConnections: 4,
        partSizeMiB: 64,
      }),
    ).toBe("custom");
  });

  test("presetMatching ignores an incoming preset label — it only looks at the knobs", () => {
    expect(
      presetMatching({
        concurrentFiles: 1,
        uploadPartsInFlight: 2,
        downloadConnections: 2,
        partSizeMiB: 8,
      }),
    ).toBe("slow");
  });
});
