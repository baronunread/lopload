import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { writeFile } from "node:fs/promises";
import { Toasty } from "@cloudflare/kumo";

import { SetupForm } from "../../../src/ui/SetupForm";
import { Onboarding } from "../../../src/ui/Onboarding";
import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { TransferWidget } from "../../../src/ui/TransferWidget";
import { ConnectionSwitcher } from "../../../src/ui/ConnectionSwitcher";
import { StatusChip } from "../../../src/ui/StatusChip";
import { ServicesProvider } from "../../../src/ui/services";
import { createServiceHarness } from "../../support/serviceHarness";
import type { Connection, TransferState } from "../../../src/lib/types";

afterEach(cleanup);

// "Bucket" is deliberately not banned: it's the provider's own word for the
// thing, and users copy the value from a console that uses it. What stays
// banned is raw protocol internals a user never needs.
const BANNED = [/object key/i, /\bprefix\b/i, /etag/i];

function assertNoJargon(container: HTMLElement) {
  const text = container.textContent ?? "";
  for (const pattern of BANNED) {
    expect(text).not.toMatch(pattern);
  }
}

describe("jargon sweep", () => {
  test(
    "no rendered screen ever says object key/prefix/ETag",
    async () => {
      const harness = await createServiceHarness();
      try {
        const conn: Connection = {
          id: "conn-1",
          name: "Videos",
          endpoint: harness.bucketConnection.endpoint,
          bucket: harness.bucketConnection.bucket,
          region: harness.bucketConnection.region,
          lastPrefix: "",
          createdAt: 0,
        };
        await harness.services.connections.save(conn, harness.credentials);
        await harness.bucket.put("photos/cat.png", "not really a png");
        await harness.bucket.put("clip.mp4", "not really a video either");

        const onboarding = render(
          <Toasty>
            <ServicesProvider value={harness.services}>
              <Onboarding onDone={() => {}} />
            </ServicesProvider>
          </Toasty>,
        );
        assertNoJargon(onboarding.container);
        onboarding.unmount();

        const setup = render(
          <Toasty>
            <ServicesProvider value={harness.services}>
              <SetupForm onSaved={() => {}} />
            </ServicesProvider>
          </Toasty>,
        );
        assertNoJargon(setup.container);
        setup.unmount();

        const browser = render(
          <Toasty>
            <ServicesProvider value={harness.services}>
              <RemoteBrowser connectionId="conn-1" prefix="" onNavigate={() => {}} />
            </ServicesProvider>
          </Toasty>,
        );
        assertNoJargon(browser.container);
        browser.unmount();

        // Give the widget something real to show: an actual completed
        // upload, exercising the widget's own chrome copy (title, badges).
        // Every TransferState's specific wording is swept exhaustively below
        // via StatusChip directly, on plain props — no bucket needed there.
        const path = `${harness.workdir}/clip.mp4`;
        await writeFile(path, "not really a video");
        await harness.services.engine.enqueueFiles("conn-1", "uploaded/", [
          { path, name: "clip.mp4", size: 19 },
        ]);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("upload never settled")), 15_000);
          const unsub = harness.services.engine.subscribe((event) => {
            if (
              event.type === "transfer-updated" &&
              event.transfer.key === "uploaded/clip.mp4" &&
              (event.transfer.state.kind === "uploaded" || event.transfer.state.kind === "failed")
            ) {
              clearTimeout(timer);
              unsub();
              resolve();
            }
          });
        });

        const widget = render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId="conn-1" />
          </ServicesProvider>,
        );
        assertNoJargon(widget.container);
        widget.unmount();

        const switcher = render(
          <ConnectionSwitcher
            connections={[conn]}
            currentId={conn.id}
            onSwitch={() => {}}
            onAddStorage={() => {}}
            onManageStorage={() => {}}
          />,
        );
        assertNoJargon(switcher.container);
        switcher.unmount();

        const states: TransferState[] = [
          { kind: "queued" },
          { kind: "sending", percent: 10 },
          { kind: "checking" },
          { kind: "uploaded" },
          { kind: "downloaded" },
          { kind: "failed", errorClass: "verification" },
        ];
        for (const state of states) {
          for (const direction of ["upload", "download"] as const) {
            const chip = render(<StatusChip state={state} direction={direction} />);
            assertNoJargon(chip.container);
            chip.unmount();
          }
        }
      } finally {
        harness.dispose();
      }
    },
    20_000,
  );
});
