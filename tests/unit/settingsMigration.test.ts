import { describe, expect, test } from "bun:test";

import { tuningFromLegacyConcurrency } from "../../src/tauri/settings";
import { DEFAULT_TUNING } from "../../src/lib/tuning";

// tuningFromLegacyConcurrency is the pure mapping getTransferTuning() uses
// to migrate a pre-tuning-model install's single `concurrentTransfers`
// knob into a full TransferTuning the first time it's read. Testing it
// directly avoids needing a live (mocked) plugin-store instance here — the
// full read/write/persist path is covered by the settings round trip in
// tests/unit/serviceConformance.test.ts.
describe("legacy concurrentTransfers -> TransferTuning migration", () => {
  test("keeps every other knob at Normal's defaults", () => {
    const migrated = tuningFromLegacyConcurrency(2);
    expect(migrated.concurrentFiles).toBe(2);
    expect(migrated.uploadPartsInFlight).toBe(DEFAULT_TUNING.uploadPartsInFlight);
    expect(migrated.downloadConnections).toBe(DEFAULT_TUNING.downloadConnections);
    expect(migrated.partSizeMiB).toBe(DEFAULT_TUNING.partSizeMiB);
  });

  test("a legacy value matching Normal's concurrentFiles (3) maps to preset normal", () => {
    expect(tuningFromLegacyConcurrency(3).preset).toBe("normal");
  });

  test("a legacy value that doesn't line up with any preset's other knobs maps to custom", () => {
    // Slow's concurrentFiles is 1, but Slow also needs uploadPartsInFlight/
    // downloadConnections of 2 — migration only ever varies concurrentFiles,
    // so this can't land on the Slow preset.
    expect(tuningFromLegacyConcurrency(1).preset).toBe("custom");
    expect(tuningFromLegacyConcurrency(4).preset).toBe("custom");
    expect(tuningFromLegacyConcurrency(5).preset).toBe("custom");
  });
});
