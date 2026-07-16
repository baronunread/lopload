// Folder creation and Trash: the two flows that PUT zero-byte folder markers.
//
// Regression coverage for the empty-body fast-path bug: createFolder and
// trashing a marker-less folder both PUT a `Uint8Array(0)` body, which SigV4
// signs with `content-length: 0`. A transport that leaves that header off the
// wire (reqwest given an empty body) turns both into SignatureDoesNotMatch —
// so these drive the real UI and then ask the bucket what actually landed.
import { fireEvent, screen, within } from "@testing-library/react";

import type { CopyProgress, TrashItem } from "../../src/ui/services";
import type { Scenario } from "./types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * True if `text` currently renders inside a table row — the file/folder
 * listing — as opposed to inside the TransferWidget. Since this fix, a
 * completed Trash move legitimately shows the same name in its own
 * "N item(s) moved to Trash" row, which (like every other move row) stays on
 * screen until dismissed — so a plain `queryByText` can no longer tell "gone
 * from the browser" apart from "still shown in the widget's history". Scope
 * to <tr> to ask the question the tests actually mean.
 */
function inTableRow(text: string): boolean {
  return screen.queryAllByText(text).some((el) => el.closest("tr") !== null);
}

export const folderAndTrashScenarios: Scenario[] = [
  {
    name: "creating a folder puts a real marker object in the bucket",
    async arrange(bucket) {
      await bucket.put("keepme.txt", "hello");
    },
    async run({ bucket, expect, user, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByText("keepme.txt") !== null).toBe(true);
      });

      await user.click(screen.getByRole("button", { name: "New folder" }));
      await user.type(screen.getByLabelText("Name"), "crates");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(async () => {
        expect(screen.queryByText("crates") !== null).toBe(true);
        expect(await bucket.has("crates/")).toBe(true);
      });
    },
  },
  {
    name: "a trashed folder leaves the bucket, shows in Trash, and Delete now purges it",
    async arrange(bucket) {
      // Deliberately no marker object for photos/ — the folder exists only as
      // a common prefix, so trashing it PUTs the zero-byte trash marker (the
      // second flow the fast-path bug broke).
      await bucket.put("photos/cat.png", "not really a png");
      await bucket.put("keepme.txt", "hello");
    },
    async run({ bucket, expect, user, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByText("photos") !== null).toBe(true);
      });

      fireEvent.contextMenu(screen.getByText("photos"));
      await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

      await waitFor(async () => {
        expect(inTableRow("photos")).toBe(false);
        expect(await bucket.has("photos/cat.png")).toBe(false);
      });
      expect(screen.queryByText("Couldn't move to Trash")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Trash" }));
      const trashDialog = await screen.findByRole("dialog");
      await waitFor(() => {
        expect(within(trashDialog).queryByText("photos") !== null).toBe(true);
      });

      // Delete now doubles as this scenario's cleanup: the trash lives at the
      // bucket root, outside the probe's guest scope on remote runs, so the
      // app's own UI is the only tool that may remove what landed there.
      await user.click(within(trashDialog).getByRole("button", { name: "Delete now" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Delete now" }));

      await waitFor(() => {
        expect(within(trashDialog).queryByText("photos")).toBeNull();
      });
    },
  },

  {
    // GitHub #10: opening the Trash while a big folder move was still
    // copying used to show every child as its own loose row, because the
    // folder's zero-byte trash marker (the thing groupTrashObjects needs to
    // collapse children into one row) was written *after* every child was
    // copied. This asserts the end state a fixed moveFolderToTrash always
    // produces — one folder row, never the 25 loose file rows a regression
    // here would risk going back to. (The actual ordering fix is pinned more
    // tightly by the request-order unit test in tests/unit/s3-trash.test.ts.)
    name: "trashing a folder with many files groups into exactly one Trash row",
    async arrange(bucket) {
      for (let i = 0; i < 25; i++) {
        await bucket.put(`bigbatch/file-${pad(i)}.txt`, `content-${i}`);
      }
    },
    async run({ user, expect, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByText("bigbatch") !== null).toBe(true);
      });

      fireEvent.contextMenu(screen.getByText("bigbatch"));
      await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }));

      await waitFor(() => {
        expect(inTableRow("bigbatch")).toBe(false);
      });

      await user.click(screen.getByRole("button", { name: "Trash" }));
      const trashDialog = await screen.findByRole("dialog");

      await waitFor(() => {
        expect(within(trashDialog).queryAllByText("bigbatch").length).toBe(1);
      });
      expect(within(trashDialog).queryByText("file-00.txt")).toBeNull();

      // Delete now doubles as this scenario's cleanup — see the comment on
      // the scenario above.
      await user.click(within(trashDialog).getByRole("button", { name: "Delete now" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Delete now" }));

      await waitFor(() => {
        expect(within(trashDialog).queryByText("bigbatch")).toBeNull();
      });
    },
  },

  {
    // GitHub #10: restoring a big folder used to show nothing but a button
    // spinner for however long the copy took. This drives the restore
    // directly through ctx.services (bypassing the UI, the way the plan
    // calls for) with an onProgress collector, and checks the progress
    // TrashDialog would now render is real: it grows, it never goes
    // backwards, and it finishes exactly at the total — not just that the
    // files eventually come back.
    name: "restoring a trashed folder reports progress that grows to every file",
    async arrange(bucket) {
      for (let i = 0; i < 14; i++) {
        await bucket.put(`restorebatch/file-${pad(i)}.txt`, `content-${i}`);
      }
    },
    async run({ services, connectionId, prefix, bucket, expect, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByText("restorebatch") !== null).toBe(true);
      });

      const folderKey = `${prefix}restorebatch/`;
      await services.browser.delete(connectionId, folderKey);

      let item: TrashItem | undefined;
      await waitFor(async () => {
        const trashed = await services.trash.list(connectionId);
        item = trashed.find((i) => i.originalKey === folderKey);
        expect(item !== undefined).toBe(true);
      });

      const events: CopyProgress[] = [];
      await services.trash.restore(connectionId, item!, (p) => {
        events.push({ ...p });
      });

      expect(events.length > 0).toBe(true);
      const last = events[events.length - 1];
      expect(last.copiedItems).toBe(last.totalItems);

      // Monotonic non-decreasing: never reports fewer items copied than a
      // previous event already claimed.
      const seq = events.map((e) => e.copiedItems);
      expect(seq).toEqual([...seq].sort((a, b) => a - b));

      for (let i = 0; i < 14; i++) {
        expect(await bucket.has(`restorebatch/file-${pad(i)}.txt`)).toBe(true);
      }
    },
  },

  {
    // GitHub #10: the bulk move-to-Trash path used to fan out one S3
    // operation per selected row with no cap, via Promise.all. This selects
    // a real range of rows and moves them all to Trash through the actual
    // UI action (context menu → "Move N items to Trash"), which now runs
    // through mapWithConcurrency(items, 3, …) — checking that capping
    // concurrency didn't drop or half-finish any of them.
    name: "moving a large selection to Trash removes every original and lists every one in Trash",
    async arrange(bucket) {
      for (let i = 0; i < 12; i++) {
        await bucket.put(`bulkcap-${pad(i)}.txt`, `content-${i}`);
      }
    },
    async run({ user, expect, waitFor, bucket, services, connectionId, prefix }) {
      await waitFor(() => {
        expect(screen.queryByText("bulkcap-00.txt") !== null).toBe(true);
      });

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
      fireEvent.click(rowFor("bulkcap-00.txt"));
      fireEvent.click(rowFor("bulkcap-11.txt"), { shiftKey: true }); // selects all 12

      fireEvent.contextMenu(rowFor("bulkcap-05.txt"));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Move 12 items to Trash" }));

      await waitFor(async () => {
        for (let i = 0; i < 12; i++) {
          expect(await bucket.has(`bulkcap-${pad(i)}.txt`)).toBe(false);
        }
      });

      let ours: TrashItem[] = [];
      await waitFor(async () => {
        const trashed = await services.trash.list(connectionId);
        ours = trashed.filter((i) => i.originalKey.startsWith(`${prefix}bulkcap-`));
        expect(ours.length).toBe(12);
      });

      // Clean up only what this scenario created — Trash lives at the
      // bucket root, outside a remote run's scoped prefix, so it's not safe
      // to Empty the whole thing here.
      for (const item of ours) {
        await services.trash.deleteNow(connectionId, item);
      }
    },
  },
];
