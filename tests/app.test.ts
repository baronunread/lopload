// Runner A: every scenario, against the real app on a Node host, talking to a
// real MinIO. This is the inner loop — the suite you run on every save.
//
// The scenarios themselves live in tests/scenarios/ and know nothing about
// bun:test, because `bun run selftest` runs the same list inside the real Tauri
// binary. Anything that belongs to the runner rather than the scenario — how a
// bucket is made, how the app is mounted, what `expect` is — is supplied here.
// Must come first — see the file for why.
import "./support/noActEnv";

import { expect, test } from "bun:test";

import { allScenarios } from "./scenarios";
import { mountApp } from "./support/appHarness";

for (const scenario of allScenarios) {
  test(
    scenario.name,
    async () => {
      const app = await mountApp(expect as never, { arrange: scenario.arrange });
      try {
        await scenario.run(app);
      } finally {
        await app.dispose();
      }
    },
    120_000,
  );
}
