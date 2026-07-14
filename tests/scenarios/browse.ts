// Browsing: what's in the bucket is what's on screen.
//
// The old version of these tests handed the UI a canned `entriesByPrefix` map.
// These put real objects in real storage and let the app go find them — so the
// listing code, the delimiter/folder synthesis, and the rendering are all on
// the hook together.
import { screen } from "@testing-library/react";

import type { Scenario } from "./types";

export const browseScenarios: Scenario[] = [
  {
    name: "lists the files and folders that are actually in the bucket",
    async run({ bucket, expect, waitFor }) {
      await bucket.put("readme.txt", "hello");
      await bucket.put("photos/cat.png", "not really a png");
      await bucket.put("photos/dog.png", "nor this");

      // The app lists on mount; the seeding above raced that first call, so
      // this waits for the listing the app does once it settles.
      await waitFor(() => {
        expect(screen.queryByText("readme.txt") !== null).toBe(true);
      });

      // "photos" is not an object — S3 has no folders. It appears only because
      // the app synthesizes it from the common prefix of the two real objects.
      expect(screen.queryByText("photos") !== null).toBe(true);
      expect(screen.queryByText("cat.png")).toBeNull();
    },
  },

  {
    name: "opening a folder shows what's inside it",
    async run({ bucket, user, expect, waitFor }) {
      await bucket.put("photos/cat.png", "meow");
      await bucket.put("readme.txt", "hello");

      await waitFor(() => {
        expect(screen.queryByText("photos") !== null).toBe(true);
      });

      await user.dblClick(screen.getByText("photos"));

      await waitFor(() => {
        expect(screen.queryByText("cat.png") !== null).toBe(true);
      });
      expect(screen.queryByText("readme.txt")).toBeNull();
    },
  },

  {
    name: "creating a folder puts a real marker object in the bucket",
    async run({ bucket, user, expect, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "New folder" }) !== null).toBe(true);
      });

      await user.click(screen.getByRole("button", { name: "New folder" }));
      await user.type(await screen.findByLabelText("Name"), "invoices");
      await user.click(screen.getByRole("button", { name: "Save" }));

      // The assertion that matters isn't the DOM — it's the bucket.
      await waitFor(async () => {
        expect(await bucket.has("invoices/")).toBe(true);
      });
    },
  },
];
