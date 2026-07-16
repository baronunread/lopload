// Browsing: what's in the bucket is what's on screen.
//
// The old version of these tests handed the UI a canned `entriesByPrefix` map.
// These put real objects in real storage and let the app go find them — so the
// listing code, the delimiter/folder synthesis, and the rendering are all on
// the hook together.
//
// Note the split: seeding happens in `arrange`, which runs before the app
// mounts. The app lists once on mount and doesn't poll, so an object written
// during `run` can lose the race and never appear.
import { screen } from "@testing-library/react";

import type { FetchFn } from "../../src/lib/s3/http-handler";
import type { Scenario } from "./types";
import { settle } from "./transfer";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestUrl(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Regression test for the "listing drops entirely mid-upload" bug
 * (GitHub #9): the debounced re-list that fires once an upload lands used to
 * blank the table on any relist failure, even though a good listing was
 * already on screen. This arms a one-shot fault on the *next* ListObjectsV2
 * call after the initial (successful) mount listing, so the relist triggered
 * by the upload's completion event fails — and asserts the already-loaded
 * row survives instead of the table blanking out.
 */
function makeUploadRefreshResilienceScenario(): Scenario {
  let armed = false;
  let faultTriggered = false;

  return {
    name: "an upload's listing refresh keeps showing what's already loaded when the relist fails",
    nodeOnly: true,
    async arrange(bucket) {
      await bucket.put("existing.txt", "hello");
    },
    wrapFetch(inner: FetchFn): FetchFn {
      return async (input, init) => {
        const url = requestUrl(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (armed && method === "GET" && url.includes("list-type=2")) {
          armed = false;
          faultTriggered = true;
          throw new TypeError("simulated transient network error during upload");
        }
        return inner(input, init);
      };
    },
    async run(ctx) {
      const { control, user, expect, waitFor, makeLocalFile } = ctx;

      // The initial mount listing must land before the fault is armed —
      // otherwise there's nothing loaded yet to preserve.
      await waitFor(() => {
        expect(screen.queryByText("existing.txt") !== null).toBe(true);
      });

      armed = true;
      const uploadPath = await makeLocalFile("uploaded.bin", "world");
      control.filesToPick = [uploadPath];
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Upload" }) !== null).toBe(true);
      });
      await user.click(screen.getByRole("button", { name: "Upload" }));
      await settle(ctx, "uploaded.bin");

      // Give the debounced re-list time to fire, hit the armed fault, and
      // (if the bug were still present) blank the table.
      await waitFor(() => {
        expect(faultTriggered).toBe(true);
      });
      await sleep(700);

      expect(screen.queryByText("existing.txt") !== null).toBe(true);
      expect(screen.queryByText("Couldn't load this storage")).toBeNull();
      expect(screen.queryByText("This folder is empty")).toBeNull();

      // The app isn't stuck: an unfaulted refresh afterwards recovers fully.
      const secondPath = await makeLocalFile("second.bin", "world2");
      control.filesToPick = [secondPath];
      await user.click(screen.getByRole("button", { name: "Upload" }));
      await settle(ctx, "second.bin");

      await waitFor(() => {
        expect(screen.queryByText("existing.txt") !== null).toBe(true);
        expect(screen.queryByText("uploaded.bin") !== null).toBe(true);
        expect(screen.queryByText("second.bin") !== null).toBe(true);
      });
    },
  };
}

/** A real 1×1 PNG, so the webview can actually decode and render it. */
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

export const browseScenarios: Scenario[] = [
  {
    name: "image rows get a preview whose presigned URL is reused across visits",
    async arrange(bucket) {
      await bucket.put("pics/cat.png", TINY_PNG);
      await bucket.put("pics/clip.mp4", "junk bytes, not a decodable video");
    },
    async run({ user, expect, waitFor }) {
      await waitFor(() => {
        expect(screen.queryByText("pics") !== null).toBe(true);
      });
      await user.dblClick(screen.getByText("pics"));

      let firstSrc = "";
      await waitFor(() => {
        const img = screen.queryByAltText("Preview of cat.png") as HTMLImageElement | null;
        expect(img !== null).toBe(true);
        firstSrc = img!.src;
      });
      expect(firstSrc).toContain("cat.png");
      expect(firstSrc).toContain("X-Amz-Signature");

      // Videos never fetch a preview — they get a film-strip icon — and the
      // row must render fine alongside the image previews.
      expect(screen.queryByText("clip.mp4") !== null).toBe(true);

      // Leave and come back: the presigned URL must come from the cache —
      // the identical string lets the webview serve the image bytes from its
      // HTTP cache instead of re-downloading on every visit.
      await user.click(screen.getAllByRole("link", { name: "Home" })[0]);
      await waitFor(() => {
        expect(screen.queryByText("pics") !== null).toBe(true);
      });
      await user.dblClick(screen.getByText("pics"));
      await waitFor(() => {
        const img = screen.queryByAltText("Preview of cat.png") as HTMLImageElement | null;
        expect(img !== null).toBe(true);
        expect(img!.src).toBe(firstSrc);
      });
    },
  },

  {
    name: "lists the files and folders that are actually in the bucket",
    async arrange(bucket) {
      await bucket.put("readme.txt", "hello");
      await bucket.put("photos/cat.png", "not really a png");
      await bucket.put("photos/dog.png", "nor this");
    },
    async run({ expect, waitFor }) {
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
    async arrange(bucket) {
      await bucket.put("photos/cat.png", "meow");
      await bucket.put("readme.txt", "hello");
    },
    async run({ user, expect, waitFor }) {
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

  makeUploadRefreshResilienceScenario(),
];
