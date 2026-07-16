// Folder creation and Trash: the two flows that PUT zero-byte folder markers.
//
// Regression coverage for the empty-body fast-path bug: createFolder and
// trashing a marker-less folder both PUT a `Uint8Array(0)` body, which SigV4
// signs with `content-length: 0`. A transport that leaves that header off the
// wire (reqwest given an empty body) turns both into SignatureDoesNotMatch —
// so these drive the real UI and then ask the bucket what actually landed.
import { fireEvent, screen, within } from "@testing-library/react";

import type { Scenario } from "./types";

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
        expect(screen.queryByText("photos")).toBeNull();
        expect(await bucket.has("photos/cat.png")).toBe(false);
      });
      expect(screen.queryByText("Couldn't move to Trash")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Trash" }));
      await waitFor(() => {
        expect(screen.queryByText("photos") !== null).toBe(true);
      });

      // Delete now doubles as this scenario's cleanup: the trash lives at the
      // bucket root, outside the probe's guest scope on remote runs, so the
      // app's own UI is the only tool that may remove what landed there.
      await user.click(screen.getByRole("button", { name: "Delete now" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Delete now" }));

      await waitFor(() => {
        expect(screen.queryByText("photos")).toBeNull();
      });
    },
  },
];
