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
import { screen, within } from "@testing-library/react";

import type { FetchFn } from "../../src/lib/s3/http-handler";
import type { Scenario } from "./types";
import { settle } from "./transfer";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Folder names sized like real-world torrent-style directories — long enough
// that, before per-crumb truncation, the ancestor crumb pushed the current
// one out of the toolbar entirely (GitHub #20).
const LONG_PARENT =
  "Neon Genesis Evangelion Complete Series [BD] [Dual Audio][1080p][HEVC 10bit x265]";
const LONG_CHILD =
  "[Anime Time] Neon Genesis Evangelion + The End of Evangelion [BD][1080p][HEVC 10bit x265]";

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
      expect(screen.queryByText("Couldn't load this storage") === null).toBe(true);
      expect(screen.queryByText("This folder is empty") === null).toBe(true);

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

/**
 * True if `text` currently renders inside a table row — the file/folder
 * listing — as opposed to inside the TransferWidget, which also shows a
 * completed upload's filename in its own history row. A plain
 * `queryByText`/`getByText` can't tell those apart once a scenario drives a
 * real upload through the engine.
 */
function inTableRow(text: string): boolean {
  return screen.queryAllByText(text).some((el) => el.closest("tr") !== null);
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
    async run({ user, expect, waitFor, prefix }) {
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
      // HTTP cache instead of re-downloading on every visit. "Leave" means
      // the folder the run started in — which is Home (the bucket root) on
      // MinIO, but the last prefix segment's breadcrumb against a real
      // provider, where Home would escape the run's lopload-test/<run>/ scope
      // and "pics" would never be seen again.
      const startSegment = prefix.split("/").filter(Boolean).pop();
      await user.click(screen.getAllByRole("link", { name: startSegment ?? "Home" })[0]);
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
      expect(screen.queryByText("cat.png") === null).toBe(true);
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
      expect(screen.queryByText("readme.txt") === null).toBe(true);
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

  {
    // GitHub #18: navigation now serves a folder's listing from a
    // stale-while-revalidate cache (src/ui/listingCache.ts) so re-entering a
    // folder renders instantly. This guards the case that would break
    // silently if a mutation site ever forgot to invalidate: a file lands in
    // "a" through the engine (not the folder's own Upload button, and not
    // while the folder is even in view) while the browser has already
    // cached "a"'s listing from an earlier visit — navigating back in must
    // still show it, not the stale two-item-short cache entry.
    name: "navigating back into a folder shows a file uploaded while elsewhere, not a stale cached listing",
    async arrange(bucket) {
      await bucket.put("a/existing.txt", "hello");
    },
    async run({ user, expect, waitFor, services, connectionId, prefix, bucket, makeLocalFile }) {
      await waitFor(() => {
        expect(screen.queryByText("a") !== null).toBe(true);
      });

      await user.dblClick(screen.getByText("a"));
      await waitFor(() => {
        expect(screen.queryByText("existing.txt") !== null).toBe(true);
      });

      // Leave "a" — its listing is now cached. "Leave" means the folder the
      // run started in, same reasoning as the preview-cache scenario above:
      // Home on MinIO, but the run's own scoped folder against a real
      // provider (Home would escape the run's lopload-test/<run>/ scope).
      const startSegment = prefix.split("/").filter(Boolean).pop();
      await user.click(screen.getAllByRole("link", { name: startSegment ?? "Home" })[0]);
      await waitFor(() => {
        expect(screen.queryByText("a") !== null).toBe(true);
      });

      const path = await makeLocalFile("new.txt", "world");
      await services.engine.enqueueFiles(connectionId, `${prefix}a/`, [
        { path, name: "new.txt", size: 5 },
      ]);
      await waitFor(async () => {
        // The upload has really landed before navigating back in — the
        // point is to catch a stale cache, not a race with the upload.
        expect(await bucket.has("a/new.txt")).toBe(true);
      });

      await user.dblClick(screen.getByText("a"));
      await waitFor(() => {
        // Scoped to the table: "new.txt" also shows in the TransferWidget's
        // completed-upload history, since this scenario drove it through the
        // real engine rather than bucket.put.
        expect(inTableRow("existing.txt")).toBe(true);
        expect(inTableRow("new.txt")).toBe(true);
      });
    },
  },

  {
    name: "very long folder names keep the current crumb rendered and ancestor crumbs clickable",
    async arrange(bucket) {
      await bucket.put(`${LONG_PARENT}/${LONG_CHILD}/movie.mkv`, "not really a video");
    },
    async run({ user, expect, waitFor, prefix }) {
      await waitFor(() => {
        expect(screen.queryByText(LONG_PARENT) !== null).toBe(true);
      });
      await user.dblClick(screen.getByText(LONG_PARENT));
      await waitFor(() => {
        expect(inTableRow(LONG_CHILD)).toBe(true);
      });
      await user.dblClick(screen.getByText(LONG_CHILD));
      await waitFor(() => {
        expect(inTableRow("movie.mkv")).toBe(true);
      });

      // The current folder's crumb is in the trail with its full name (CSS
      // ellipsizes it visually; happy-dom runs no layout, so what's checkable
      // is that the crumb is there and carries the whole name).
      const current = document.querySelector('[aria-current="page"]');
      expect(current !== null).toBe(true);
      expect(current!.textContent).toContain(LONG_CHILD);

      // The long ancestor crumb — now a truncating box instead of
      // display:contents — must still navigate on click.
      await user.click(screen.getAllByRole("link", { name: LONG_PARENT })[0]);
      await waitFor(() => {
        expect(inTableRow(LONG_CHILD)).toBe(true);
      });

      // The Move dialog renders the same trail: Home must survive (it was
      // crushed to a sliver before #20) and stay clickable.
      await user.click(screen.getByRole("button", { name: `Actions for ${LONG_CHILD}` }));
      await user.click(await screen.findByRole("menuitem", { name: "Move to…" }));
      const dialog = await screen.findByRole("dialog");
      const dialogCurrent = dialog.querySelector('[aria-current="page"]');
      expect(dialogCurrent !== null).toBe(true);
      expect(dialogCurrent!.textContent).toContain(LONG_PARENT);
      // Go up one level inside the dialog — to Home on MinIO, but only to
      // the run's own scoped folder against a real provider (same caveat as
      // the toolbar navigation scenarios above).
      const startSegment = prefix.split("/").filter(Boolean).pop();
      await user.click(
        within(dialog).getAllByRole("link", { name: startSegment ?? "Home" })[0],
      );
      await waitFor(() => {
        expect(within(dialog).queryByText(LONG_PARENT) !== null).toBe(true);
      });
    },
  },
];
