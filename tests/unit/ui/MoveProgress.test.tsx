import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { TransferWidget } from "../../../src/ui/TransferWidget";
import { MoveProgressProvider } from "../../../src/ui/browser/MoveProgressContext";
import { ServicesProvider } from "../../../src/ui/services";
import { faultyFetch } from "../../support/faultyFetch";
import { createServiceHarness, type ServiceHarness } from "../../support/serviceHarness";

afterEach(cleanup);

const CONN = "conn-1";

async function saveConnection(harness: ServiceHarness): Promise<void> {
  await harness.services.connections.save(
    {
      id: CONN,
      name: "Test",
      endpoint: harness.bucketConnection.endpoint,
      bucket: harness.bucketConnection.bucket,
      region: harness.bucketConnection.region,
      lastPrefix: "",
      createdAt: Date.now(),
    },
    harness.credentials,
  );
}

function renderWidget(harness: ServiceHarness) {
  return render(
    <ServicesProvider value={harness.services}>
      <MoveProgressProvider>
        <TransferWidget connectionId={CONN} />
      </MoveProgressProvider>
    </ServicesProvider>,
  );
}

describe("move progress in the transfer widget", () => {
  test(
    "counts only the moves still running in the title, not the ones already done",
    async () => {
      const harness = await createServiceHarness({
        wrapFetch: (inner) =>
          faultyFetch(inner, [
            { urlContains: "ArchiveC/", method: "PUT", action: { kind: "stall", ms: 10_000 } },
          ]),
      });
      try {
        await saveConnection(harness);
        for (const folder of ["FolderA", "FolderB"]) {
          for (let i = 0; i < 13; i++) {
            await harness.bucket.put(`${folder}/f${i}.bin`, new Uint8Array([i]));
          }
        }
        for (let i = 0; i < 5; i++) {
          await harness.bucket.put(`FolderC/f${i}.bin`, new Uint8Array([i]));
        }

        renderWidget(harness);

        // Two moves run to completion while the widget is mounted and
        // subscribed, so it sees every event including the final "completed".
        await harness.services.browser.move(CONN, "FolderA/", "ArchiveA/");
        await harness.services.browser.move(CONN, "FolderB/", "ArchiveB/");
        // A third move whose copies are held open by the stall fault above.
        void harness.services.browser.move(CONN, "FolderC/", "ArchiveC/");

        // "1" here counts moves still in flight (one), not the item count.
        await screen.findByText("Moving 1 item…");
        expect(screen.queryByText("Moving 3 items…")).not.toBeInTheDocument();
        // The two finished moves each render their own summary row. Their
        // "completed" events and the third move's "moving" event are separate
        // React updates, so the title above can be on screen a beat before both
        // summaries are — wait for them rather than assuming they landed together.
        await waitFor(() => expect(screen.getAllByText("13 items moved")).toHaveLength(2));
      } finally {
        await harness.dispose();
      }
    },
    30_000,
  );

  test(
    "summarizes once every move has landed",
    async () => {
      const harness = await createServiceHarness({
        wrapFetch: (inner) =>
          faultyFetch(inner, [
            {
              urlContains: "Archive/f0.bin",
              method: "PUT",
              action: { kind: "stall", ms: 150 },
            },
          ]),
      });
      try {
        await saveConnection(harness);
        for (let i = 0; i < 3; i++) {
          await harness.bucket.put(`Folder/f${i}.bin`, new Uint8Array([i]));
        }

        renderWidget(harness);

        const movePromise = harness.services.browser.move(CONN, "Folder/", "Archive/");
        await screen.findByText("Moving 1 item…");

        await movePromise;
        await screen.findByText("1 item moved");
      } finally {
        await harness.dispose();
      }
    },
    15_000,
  );

  test(
    "leads with bytes so the detail line can't contradict the bar",
    async () => {
      const harness = await createServiceHarness({
        wrapFetch: (inner) =>
          faultyFetch(inner, [
            // Freezes the big object's 2nd (of 2) multipart-copy part, so the
            // move sits with one whole object copied and the other half-in.
            { urlContains: "partNumber=2", method: "PUT", action: { kind: "stall", ms: 10_000 } },
          ]),
      });
      try {
        await saveConnection(harness);
        // 1 MiB — copies atomically, contributing its whole size at once.
        await harness.bucket.put("Folder/a.bin", new Uint8Array(1024 * 1024));
        // Exactly COPY_MULTIPART_THRESHOLD (64 MiB) — triggers a 2-part
        // multipart copy (COPY_PART_SIZE is 32 MiB), so part 1 lands as
        // partial progress on an object that's still "in progress".
        await harness.bucket.put("Folder/big.bin", new Uint8Array(64 * 1024 * 1024));

        renderWidget(harness);
        void harness.services.browser.move(CONN, "Folder/", "Archive/");

        // 1 MiB (a.bin) + 32 MiB (big.bin's landed first part) = 33 MB copied
        // of 65 MB total, with only 1 of 2 objects actually finished — the
        // detail line must lead with the bytes, not "1 of 2 items".
        await waitFor(() => expect(screen.getByText(/33 MB of 65 MB/)).toBeInTheDocument());
        expect(screen.getByText("33 MB of 65 MB · 2 items")).toBeInTheDocument();
        expect(screen.queryByText(/1 of 2 items/)).not.toBeInTheDocument();
        expect(screen.getByText("50%")).toBeInTheDocument();
      } finally {
        await harness.dispose();
      }
    },
    30_000,
  );

  test(
    "falls back to an item count for a folder with no bytes in it",
    async () => {
      const harness = await createServiceHarness({
        wrapFetch: (inner) =>
          faultyFetch(inner, [
            { urlContains: "Archive/m2", method: "PUT", action: { kind: "stall", ms: 10_000 } },
            { urlContains: "Archive/m3", method: "PUT", action: { kind: "stall", ms: 10_000 } },
          ]),
      });
      try {
        await saveConnection(harness);
        // Empty marker objects — a folder with structure but no bytes.
        for (const name of ["m0", "m1", "m2", "m3"]) {
          await harness.bucket.put(`Folder/${name}`, new Uint8Array(0));
        }

        renderWidget(harness);
        void harness.services.browser.move(CONN, "Folder/", "Archive/");

        await screen.findByText("2 of 4 items");
        expect(screen.getByText("50%")).toBeInTheDocument();
      } finally {
        await harness.dispose();
      }
    },
    15_000,
  );

  test(
    "holds short of 100% until the move actually reports completion",
    async () => {
      const harness = await createServiceHarness({
        wrapFetch: (inner) =>
          faultyFetch(inner, [
            // The delete-originals pass runs after every object is copied —
            // holding it open catches the window where copying finished but
            // the move as a whole hasn't.
            { urlContains: "?delete", method: "POST", action: { kind: "stall", ms: 600 } },
          ]),
      });
      try {
        await saveConnection(harness);
        for (let i = 0; i < 3; i++) {
          await harness.bucket.put(`Folder/f${i}.bin`, new Uint8Array([i]));
        }

        renderWidget(harness);
        const movePromise = harness.services.browser.move(CONN, "Folder/", "Archive/");

        // Every byte and item copied, but the delete pass is still pending —
        // a full bar here would be a lie about the move being done.
        await screen.findByText("99%");

        await movePromise;
        await screen.findByText("1 item moved");
      } finally {
        await harness.dispose();
      }
    },
    15_000,
  );
});
