// Uploads and downloads, driven from the UI, verified in the bucket and on disk.
//
// This is the file that replaces "test it by hand against a real bucket". Every
// byte here makes a real round trip: the engine chunks it, the SDK signs it,
// MinIO stores it, and the assertion reads it back out through a different
// client than the one the app used.
import { screen } from "@testing-library/react";

import { MULTIPART_THRESHOLD } from "../../src/lib/s3/multipart";
import type { Scenario, ScenarioCtx } from "./types";

/** Deterministic pseudo-random bytes — real enough that a truncated or
 * misordered upload can't accidentally still match. */
function bytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Waits for the transfer of `name` to reach a terminal state, and returns it.
 *
 * `name` is the filename as the scenario thinks of it; the app's Transfer carries
 * the full remote key, which is prefix + name. On MinIO the prefix is empty and
 * the two coincide — which is exactly why this is easy to get wrong and only
 * discover against a real provider.
 */
export async function settle(ctx: ScenarioCtx, name: string, timeoutMs = 60_000) {
  const { services, connectionId, prefix } = ctx;
  const key = `${prefix}${name}`;
  return new Promise<{ kind: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`transfer for ${key} never settled`)),
      timeoutMs,
    );
    const done = (state: { kind: string }) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const unsubscribe = services.engine.subscribe((event) => {
      if (event.type !== "transfer-updated" || event.transfer.key !== key) return;
      const { kind } = event.transfer.state;
      if (kind === "uploaded" || kind === "downloaded" || kind === "failed") {
        done(event.transfer.state);
      }
    });
    // The transfer may already be terminal before we subscribed.
    void services.engine.listTransfers(connectionId).then((list) => {
      const match = list.find((t) => t.key === key);
      if (!match) return;
      const { kind } = match.state;
      if (kind === "uploaded" || kind === "downloaded" || kind === "failed") {
        done(match.state);
      }
    });
  });
}

export const transferScenarios: Scenario[] = [
  {
    name: "uploading through the Upload button puts the exact bytes in the bucket",
    async run(ctx) {
      const { bucket, control, user, expect, waitFor, makeLocalFile } = ctx;
      const payload = bytes(64 * 1024, 7);
      const path = await makeLocalFile("report.bin", payload);

      // The native picker can't be clicked, so script what it returns — this
      // is the one substitution in the whole flow.
      control.filesToPick = [path];

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Upload" }) !== null).toBe(true);
      });
      await user.click(screen.getByRole("button", { name: "Upload" }));

      const state = await settle(ctx, "report.bin");
      expect(state.kind).toBe("uploaded");

      const stored = await bucket.get("report.bin");
      expect(stored === null).toBe(false);
      expect(Array.from(stored!)).toEqual(Array.from(payload));
    },
  },

  {
    name: "a multipart-sized upload round-trips byte for byte",
    async run(ctx) {
      const { bucket, control, user, expect, waitFor, makeLocalFile } = ctx;
      // Over the threshold, so this takes the multipart path (CreateMultipart /
      // UploadPart x N / CompleteMultipart) rather than a single PutObject.
      const payload = bytes(MULTIPART_THRESHOLD + 1024 * 1024, 11);
      const path = await makeLocalFile("big.bin", payload);
      control.filesToPick = [path];

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Upload" }) !== null).toBe(true);
      });
      await user.click(screen.getByRole("button", { name: "Upload" }));

      const state = await settle(ctx, "big.bin", 120_000);
      expect(state.kind).toBe("uploaded");

      const stored = await bucket.get("big.bin");
      expect(stored!.byteLength).toBe(payload.byteLength);
      // Compare a few windows rather than every byte: a part that landed at the
      // wrong offset shows up here, without a 17MB element-wise diff.
      for (const at of [0, 1_000_000, MULTIPART_THRESHOLD - 1, payload.byteLength - 1]) {
        expect(stored![at]).toBe(payload[at]);
      }
    },
  },

  {
    name: "downloading writes the real bytes to the chosen local path",
    // Seeded in arrange, not run: the app lists the folder once on mount and
    // never polls, so a put issued from run() races that listing. MinIO on
    // localhost answers fast enough to hide the race; a real provider doesn't.
    async arrange(bucket) {
      await bucket.put("archive.bin", bytes(128 * 1024, 3));
    },
    async run(ctx) {
      const { control, workdir, user, expect, waitFor, readLocalFile } = ctx;
      const payload = bytes(128 * 1024, 3);

      const destination = `${workdir}/downloaded.bin`;
      control.saveDestination = destination;

      await waitFor(() => {
        expect(screen.queryByText("archive.bin") !== null).toBe(true);
      });

      await user.click(screen.getByRole("button", { name: "Actions for archive.bin" }));
      await user.click(await screen.findByText("Download"));

      const state = await settle(ctx, "archive.bin");
      expect(state.kind).toBe("downloaded");

      // Read it off the actual filesystem — not from any test double.
      const written = await readLocalFile(destination);
      expect(written.byteLength).toBe(payload.byteLength);
      expect(Array.from(written.subarray(0, 256))).toEqual(Array.from(payload.subarray(0, 256)));
    },
  },

  {
    name: "an OS drag shows the upload overlay and dropping on a folder row uploads into that folder",
    async arrange(bucket) {
      await bucket.put("docs/existing.txt", "already here");
    },
    async run(ctx) {
      const { bucket, control, expect, waitFor, makeLocalFile, prefix } = ctx;
      const payload = bytes(32 * 1024, 11);
      const path = await makeLocalFile("report.bin", payload);

      const rowSelector = `[data-drop-prefix="${prefix}docs/"]`;
      await waitFor(() => {
        expect(document.querySelector(rowSelector) !== null).toBe(true);
      });

      // happy-dom runs no layout, so every element's rect is zero-size — and
      // the hit test skips zero-size rects. Give the docs row a real one so
      // the cursor can land on it.
      const row = document.querySelector(rowSelector) as HTMLElement;
      row.getBoundingClientRect = () =>
        ({
          left: 0, top: 100, right: 800, bottom: 156,
          width: 800, height: 56, x: 0, y: 100,
          toJSON: () => ({}),
        }) as DOMRect;

      // Drag in over empty space: the overlay comes up naming the current
      // folder (the bucket root shows as Home).
      control.dragFileHover({ x: 400, y: 50 });
      await waitFor(() => {
        const overlay = screen.queryByText(/Drop to upload to/);
        expect(overlay !== null).toBe(true);
        expect(overlay!.textContent).toContain("Home");
      });

      // Drag over the docs row: it highlights as the target and the overlay
      // names it.
      control.dragFileHover({ x: 400, y: 128 });
      await waitFor(() => {
        expect(screen.getByText(/Drop to upload to/).textContent).toContain("docs");
        expect((document.querySelector(rowSelector) as HTMLElement).className).toContain(
          "ring-kumo-brand",
        );
      });

      // Drop: the file must land under docs/, not in the folder being viewed.
      control.dropFiles([path]);
      const state = await settle(ctx, "docs/report.bin");
      expect(state.kind).toBe("uploaded");

      const stored = await bucket.get("docs/report.bin");
      expect(stored !== null).toBe(true);
      expect(stored!.byteLength).toBe(payload.byteLength);
      expect(Array.from(stored!.subarray(0, 256))).toEqual(Array.from(payload.subarray(0, 256)));

      // The overlay leaves once the drop lands — eventually, not instantly:
      // AnimatePresence keeps it mounted through its exit animation.
      await waitFor(() => {
        expect(screen.queryByText(/Drop to upload to/) === null).toBe(true);
      });
    },
  },
];
