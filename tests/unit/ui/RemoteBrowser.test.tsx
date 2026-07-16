import "../../support/noActEnv";

import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { Toasty } from "@cloudflare/kumo";

import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { ServicesProvider } from "../../../src/ui/services";
import { formatBytes, formatDate } from "../../../src/ui/format";
import type { FetchFn } from "../../../src/lib/s3/http-handler";
import { faultyFetch, type Fault } from "../../support/faultyFetch";
import { createServiceHarness, type ServiceHarness } from "../../support/serviceHarness";

afterEach(cleanup);

// Real MinIO round trips take longer than bun's 5s default.
const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, 20_000);

const CONN = "conn-1";

async function harnessWithConnection(faults: Fault[] = []): Promise<ServiceHarness> {
  const harness = await createServiceHarness(
    faults.length > 0 ? { wrapFetch: (inner) => faultyFetch(inner, faults) } : {},
  );
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
  return harness;
}

function Harness() {
  const [prefix, setPrefix] = useState("");
  return (
    <Toasty>
      <RemoteBrowser connectionId={CONN} prefix={prefix} onNavigate={setPrefix} />
    </Toasty>
  );
}

function renderBrowser(harness: ServiceHarness) {
  return render(
    <ServicesProvider value={harness.services}>
      <Harness />
    </ServicesProvider>,
  );
}

async function currentLastPrefix(harness: ServiceHarness): Promise<string | undefined> {
  const list = await harness.services.connections.list();
  return list.find((c) => c.id === CONN)?.lastPrefix;
}

/** Drives the pointer-based drag-to-move (internal moves don't use HTML5
 * DnD — Tauri swallows DOM drop events): press the source row, move past
 * the drag threshold, hover the target, release. */
function dragRowTo(source: HTMLElement, target: HTMLElement) {
  fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.mouseMove(document, { clientX: 60, clientY: 60 });
  fireEvent.mouseOver(target);
  fireEvent.mouseUp(document);
}

describe("RemoteBrowser", () => {
  test("breadcrumb navigation updates the listing and calls setLastPrefix", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");
      await harness.bucket.put("photos/cat.png", "meow");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.dblClick(screen.getByText("photos"));
      await screen.findByText("cat.png");
      expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
      await waitFor(async () => expect(await currentLastPrefix(harness)).toBe("photos/"));

      // Breadcrumb "Home" navigates back to root. Kumo's Breadcrumbs renders a
      // duplicate mobile/desktop pair, so pick the first match.
      await user.click(screen.getAllByText("Home")[0]);
      await screen.findByText("readme.txt");
      await waitFor(async () => expect(await currentLastPrefix(harness)).toBe(""));
    } finally {
      await harness.dispose();
    }
  });

  test("a deep path collapses ancestor breadcrumbs behind a '…' menu, keeping the toolbar actions reachable", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("alpha/beta/gamma/delta/epsilon/leaf.txt", "hi");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("alpha");

      // Navigate five levels deep, one double-click at a time.
      await user.dblClick(screen.getByText("alpha"));
      await screen.findByText("beta");
      await user.dblClick(screen.getByText("beta"));
      await screen.findByText("gamma");
      await user.dblClick(screen.getByText("gamma"));
      await screen.findByText("delta");
      await user.dblClick(screen.getByText("delta"));
      await screen.findByText("epsilon");
      await user.dblClick(screen.getByText("epsilon"));
      await screen.findByText("leaf.txt");
      await waitFor(async () =>
        expect(await currentLastPrefix(harness)).toBe("alpha/beta/gamma/delta/epsilon/"),
      );

      // Only Home plus the last two segments (delta, epsilon) show — the
      // toolbar's action buttons stay reachable regardless.
      expect(screen.getAllByText("Home")[0]).toBeInTheDocument();
      expect(screen.getAllByText("delta")[0]).toBeInTheDocument();
      expect(screen.getAllByText("epsilon")[0]).toBeInTheDocument();
      expect(screen.queryByText("alpha")).not.toBeInTheDocument();
      expect(screen.queryByText("beta")).not.toBeInTheDocument();
      expect(screen.queryByText("gamma")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "New folder" }),
      ).toBeInTheDocument();

      // The "…" trigger lists the hidden ancestors, top-down, each
      // navigable — pick the first of the duplicated mobile/desktop pair.
      const trigger = screen.getAllByRole("button", { name: "Show 3 hidden folders" })[0];
      await user.click(trigger);

      const menu = await screen.findByRole("menu");
      const items = within(menu).getAllByRole("menuitem");
      expect(items.map((item) => item.textContent)).toEqual(["alpha", "beta", "gamma"]);

      // Clicking a hidden ancestor navigates straight there.
      await user.click(within(menu).getByRole("menuitem", { name: "beta" }));

      await waitFor(async () => expect(await currentLastPrefix(harness)).toBe("alpha/beta/"));
      await screen.findByText("gamma");
      // Only two segments now — no collapsing needed, so the menu trigger
      // is gone and both ancestor crumbs are plain, visible links.
      expect(screen.queryByRole("button", { name: /hidden folder/ })).not.toBeInTheDocument();
      expect(screen.getAllByText("alpha")[0]).toBeInTheDocument();
      expect(screen.getAllByText("beta")[0]).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("shows an empty state when a folder has no entries", async () => {
    const harness = await harnessWithConnection();
    try {
      renderBrowser(harness);
      await screen.findByText("This folder is empty");
    } finally {
      await harness.dispose();
    }
  });

  test("an unreadable keychain entry shows the re-entry flow, and saving credentials reconnects", async () => {
    const harness = await createServiceHarness();
    try {
      await harness.bucket.put("readme.txt", "hello");
      // Reproduce a denied-keychain-prompt gap for real: write the
      // connection row straight into the store without ever calling
      // keychain.set — the same shape a saved connection has after the OS
      // keychain refuses to hand back its secret.
      const store = await harness.host.stores.connections();
      await store.save({
        id: CONN,
        name: "Test",
        endpoint: harness.bucketConnection.endpoint,
        bucket: harness.bucketConnection.bucket,
        region: harness.bucketConnection.region,
        lastPrefix: "",
        createdAt: Date.now(),
      });
      const user = userEvent.setup();

      renderBrowser(harness);

      await screen.findByText("We couldn't read the saved credentials for this storage");
      expect(screen.queryByText("Couldn't load this storage")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("Access key"), harness.credentials.accessKey);
      await user.type(screen.getByLabelText("Secret key"), harness.credentials.secretKey);
      await user.click(screen.getByRole("button", { name: "Reconnect" }));

      await screen.findByText("readme.txt");
      expect(await harness.host.keychain.get(CONN)).toEqual(harness.credentials);
    } finally {
      await harness.dispose();
    }
  });

  test("cancelling the re-entry flow falls back to the plain retryable error state, not a crash", async () => {
    const harness = await createServiceHarness();
    try {
      const store = await harness.host.stores.connections();
      await store.save({
        id: CONN,
        name: "Test",
        endpoint: harness.bucketConnection.endpoint,
        bucket: harness.bucketConnection.bucket,
        region: harness.bucketConnection.region,
        lastPrefix: "",
        createdAt: Date.now(),
      });
      const user = userEvent.setup();

      renderBrowser(harness);

      await screen.findByText("We couldn't read the saved credentials for this storage");
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await screen.findByText("Couldn't load this storage");
      expect(
        screen.queryByText("We couldn't read the saved credentials for this storage"),
      ).not.toBeInTheDocument();
      expect(await harness.host.keychain.get(CONN)).toBeNull();
    } finally {
      await harness.dispose();
    }
  });

  test("the per-row '⋯' touch trigger opens the same context menu as right-click", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));

      const menu = await screen.findByRole("menu");
      expect(menu).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Move to Trash" })).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("right-clicking a row keeps it highlighted and suppresses hover on other rows while the menu is open", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      // Before any menu is open, idle rows carry the plain hover class.
      expect(rowFor("a.txt").className).toContain("hover:bg-kumo-tint");
      expect(rowFor("b.txt").className).toContain("hover:bg-kumo-tint");

      fireEvent.contextMenu(rowFor("a.txt"));
      await screen.findByRole("menu");

      // The right-clicked row gets the selected-style highlight...
      expect(rowFor("a.txt").className).toContain("bg-kumo-brand/10");
      expect(rowFor("a.txt").className).toContain("ring-kumo-brand/50");
      // ...and stays highlighted while the pointer moves over it.
      fireEvent.mouseOver(rowFor("a.txt"));
      expect(rowFor("a.txt").className).toContain("bg-kumo-brand/10");

      // Other rows lose their hover class entirely while the menu is open.
      expect(rowFor("b.txt").className).not.toContain("hover:bg-kumo-tint");

      // Closing the menu restores normal hover behavior on every row.
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
      expect(rowFor("a.txt").className).not.toContain("bg-kumo-brand/10");
      expect(rowFor("a.txt").className).toContain("hover:bg-kumo-tint");
      expect(rowFor("b.txt").className).toContain("hover:bg-kumo-tint");
    } finally {
      await harness.dispose();
    }
  });

  test("right-clicking empty space opens the background menu with no row highlighted, and still suppresses hover", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");

      const { container } = renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
      const background = container.querySelector(".relative.flex.h-full") as HTMLElement;

      fireEvent.contextMenu(background);
      const menu = await screen.findByRole("menu");
      expect(menu).toBeInTheDocument();

      // No row is the target of the background menu — it stays unhighlighted...
      expect(rowFor("a.txt").className).not.toContain("bg-kumo-brand/10");
      // ...but hover is still suppressed while the menu is up.
      expect(rowFor("a.txt").className).not.toContain("hover:bg-kumo-tint");
    } finally {
      await harness.dispose();
    }
  });

  test("re-lists the current folder once an upload finishes", async () => {
    const harness = await harnessWithConnection();
    try {
      renderBrowser(harness);
      await screen.findByText("This folder is empty");

      // A real upload, enqueued directly through the engine (as a drag-drop
      // or the Upload button would) — the browser must notice the resulting
      // engine event and re-list on its own, without navigating away.
      const path = `${harness.workdir}/readme.txt`;
      await writeFile(path, "hello");
      await harness.services.engine.enqueueFiles(CONN, "", [
        { path, name: "readme.txt", size: 5 },
      ]);

      await screen.findByText("readme.txt", {}, { timeout: 15_000 });
    } finally {
      await harness.dispose();
    }
  });

  test("double-clicking a file opens its info dialog; folders still navigate", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");
      await harness.bucket.put("photos/cat.png", "meow");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      // Double-click must never kick off a location-less download — it shows
      // the file's details instead.
      await user.dblClick(screen.getByText("readme.txt"));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("File info")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      // Folders still navigate on double-click, without opening anything.
      await user.dblClick(screen.getByText("photos"));
      await screen.findByText("cat.png");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("the context menu offers a 'File info' item that opens the same debug dialog", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByRole("menuitem", { name: "File info" })).toBeInTheDocument();

      await user.click(within(menu).getByRole("menuitem", { name: "File info" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/File info/)).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("dragging a row onto a folder row moves it via the browser service", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");
      await harness.bucket.put("photos/cat.png", "meow");

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      const fileRow = screen.getByText("readme.txt").closest("tr");
      const folderRow = screen.getByText("photos").closest("tr");
      expect(fileRow).toBeTruthy();
      expect(folderRow).toBeTruthy();

      dragRowTo(fileRow as HTMLElement, folderRow as HTMLElement);

      await waitFor(async () => {
        expect(await harness.bucket.has("photos/readme.txt")).toBe(true);
        expect(await harness.bucket.has("readme.txt")).toBe(false);
      });
    } finally {
      await harness.dispose();
    }
  });

  test("shift-click extends a range selection, and dragging any selected row moves the whole selection", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      await harness.bucket.put("c.txt", "c");
      await harness.bucket.put("photos/marker", "");

      renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      // Select a.txt, then shift-click c.txt: selects a, b, c (not "photos").
      fireEvent.click(rowFor("a.txt"));
      fireEvent.click(rowFor("c.txt"), { shiftKey: true });

      dragRowTo(rowFor("b.txt"), rowFor("photos"));

      await waitFor(async () => {
        expect(await harness.bucket.has("photos/a.txt")).toBe(true);
        expect(await harness.bucket.has("photos/b.txt")).toBe(true);
        expect(await harness.bucket.has("photos/c.txt")).toBe(true);
      });
    } finally {
      await harness.dispose();
    }
  });

  test("cmd/ctrl-click toggles rows independently, and Escape clears the whole selection", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      await harness.bucket.put("c.txt", "c");
      await harness.bucket.put("photos/marker", "");

      renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      // cmd-click both a.txt and b.txt into the selection.
      fireEvent.click(rowFor("a.txt"));
      fireEvent.click(rowFor("b.txt"), { metaKey: true });

      // Escape clears the selection entirely.
      fireEvent.keyDown(document, { key: "Escape" });

      // Dragging a.txt now moves only itself — if Escape hadn't cleared the
      // two-row selection, this would have moved b.txt along with it.
      dragRowTo(rowFor("a.txt"), rowFor("photos"));

      await waitFor(async () => expect(await harness.bucket.has("photos/a.txt")).toBe(true));
      expect(await harness.bucket.has("photos/b.txt")).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  test("right-clicking a row within a multi-selection offers bulk delete, pluralized", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      await harness.bucket.put("c.txt", "c");
      await harness.bucket.put("photos/marker", "");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      fireEvent.click(rowFor("a.txt"));
      fireEvent.click(rowFor("c.txt"), { shiftKey: true }); // selects a, b, c

      fireEvent.contextMenu(rowFor("b.txt"));
      const menu = await screen.findByRole("menu");
      // Moving to Trash is low-stakes (recoverable), so it acts immediately —
      // no confirmation dialog, unlike Delete now/Empty trash in the Trash view.
      await user.click(within(menu).getByRole("menuitem", { name: "Move 3 items to Trash" }));

      await waitFor(async () => {
        expect(await harness.bucket.has("a.txt")).toBe(false);
        expect(await harness.bucket.has("b.txt")).toBe(false);
        expect(await harness.bucket.has("c.txt")).toBe(false);
      });
    } finally {
      await harness.dispose();
    }
  });

  test("bulk download on a multi-selection enqueues files directly and folders recursively", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("photos/cat.png", "meow");
      await harness.bucket.put("photos/2024/dog.png", "woof");
      const destDir = `${harness.workdir}/dest`;
      await mkdir(destDir, { recursive: true });
      harness.control.directoryToPick = destDir;
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("a.txt");

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      fireEvent.click(rowFor("photos"));
      fireEvent.click(rowFor("a.txt"), { metaKey: true });

      fireEvent.contextMenu(rowFor("a.txt"));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Download 2 items" }));

      await waitFor(
        async () => {
          const a = await readFile(`${destDir}/a.txt`, "utf-8").catch(() => null);
          const cat = await readFile(`${destDir}/photos/cat.png`, "utf-8").catch(() => null);
          const dog = await readFile(`${destDir}/photos/2024/dog.png`, "utf-8").catch(() => null);
          expect(a).toBe("a");
          expect(cat).toBe("meow");
          expect(dog).toBe("woof");
        },
        { timeout: 15_000 },
      );
    } finally {
      await harness.dispose();
    }
  });

  test("the folder info dialog shows the computed size and last-changed date", async () => {
    const harness = await harnessWithConnection();
    try {
      const sizes = [1_000_000, 2_000_000, 2_033_164];
      for (const [i, size] of sizes.entries()) {
        await harness.bucket.put(`photos/f${i}.bin`, new Uint8Array(size));
      }
      const totalSize = sizes.reduce((a, b) => a + b, 0);
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("photos");

      await user.click(screen.getByRole("button", { name: "Actions for photos" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Folder info" }));

      const dialog = await screen.findByRole("dialog");
      // The dialog shows real, computed stats — 3 real objects, their real
      // total size, and today's date (S3 stamps LastModified at write time).
      const expected = `3 files, ${formatBytes(totalSize)}, last changed ${formatDate(Date.now())}`;
      await within(dialog).findByText(expected, undefined, { timeout: 15_000 });
    } finally {
      await harness.dispose();
    }
  });

  test("shows an error toast when a dropped item can't be read", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("readme.txt", "hello");

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      // Drop a path that genuinely doesn't exist on disk — a real,
      // unreadable item, the same shape a permission-denied file has.
      act(() => {
        harness.control.dropFiles([`${harness.workdir}/does-not-exist.bin`]);
      });

      await screen.findByText(/Some of what you dropped couldn't be added/);
      await screen.findByText(/couldn't be read/);
    } finally {
      await harness.dispose();
    }
  });

  test("clicking the Size header sorts files by size, folders always first", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("zzz-folder/marker", "");
      await harness.bucket.put("big.bin", new Uint8Array(3000));
      await harness.bucket.put("small.bin", new Uint8Array(10));
      await harness.bucket.put("mid.bin", new Uint8Array(500));
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("big.bin");

      const rowNames = () =>
        screen.getAllByRole("row").slice(1).map((row) => row.textContent ?? "");

      await user.click(screen.getByRole("button", { name: "Size" }));
      let names = rowNames();
      expect(names[0]).toContain("zzz-folder");
      expect(names.slice(1).findIndex((t) => t.includes("small.bin"))).toBeLessThan(
        names.slice(1).findIndex((t) => t.includes("mid.bin")),
      );
      expect(names.slice(1).findIndex((t) => t.includes("mid.bin"))).toBeLessThan(
        names.slice(1).findIndex((t) => t.includes("big.bin")),
      );

      // Clicking again flips to descending.
      await user.click(screen.getByRole("button", { name: "Size" }));
      names = rowNames();
      expect(names.slice(1).findIndex((t) => t.includes("big.bin"))).toBeLessThan(
        names.slice(1).findIndex((t) => t.includes("mid.bin")),
      );
    } finally {
      await harness.dispose();
    }
  });

  test("the filter field narrows rows by name, and Escape clears it before the selection", async () => {
    const harness = await harnessWithConnection();
    try {
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      await harness.bucket.put("c.txt", "c");
      await harness.bucket.put("photos/marker", "");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("a.txt");

      fireEvent.click(screen.getByText("a.txt").closest("tr") as HTMLElement);
      expect((screen.getByText("a.txt").closest("tr") as HTMLElement).className).toContain(
        "bg-kumo-brand",
      );

      const filterInput = screen.getByLabelText("Filter this folder");
      await user.type(filterInput, "b.txt");

      expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
      expect(screen.queryByText("photos")).not.toBeInTheDocument();
      await screen.findByText("b.txt");

      // First Escape clears the filter, not the (still-intact) selection.
      fireEvent.keyDown(document, { key: "Escape" });
      await screen.findByText("a.txt");
      expect(filterInput).toHaveValue("");

      dragRowTo(
        screen.getByText("a.txt").closest("tr") as HTMLElement,
        screen.getByText("photos").closest("tr") as HTMLElement,
      );

      await waitFor(async () => expect(await harness.bucket.has("photos/a.txt")).toBe(true));

      // A second Escape (filter already empty) clears the selection.
      fireEvent.click(screen.getByText("b.txt").closest("tr") as HTMLElement);
      fireEvent.keyDown(document, { key: "Escape" });
      dragRowTo(
        screen.getByText("c.txt").closest("tr") as HTMLElement,
        screen.getByText("photos").closest("tr") as HTMLElement,
      );

      await waitFor(async () => expect(await harness.bucket.has("photos/c.txt")).toBe(true));
      expect(await harness.bucket.has("photos/b.txt")).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  test("moving a file to Trash removes its row optimistically, before the delete call resolves — and rolls back with a toast on rejection", async () => {
    const harness = await harnessWithConnection([
      {
        urlContains: "readme.txt",
        method: "DELETE",
        action: { kind: "s3Error", status: 500, code: "InternalError", message: "boom" },
      },
    ]);
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));

      // The row disappears immediately — the real delete call is still
      // in flight (and, per the fault above, about to fail).
      await waitFor(() => expect(screen.queryByText("readme.txt")).not.toBeInTheDocument());

      // The failed delete rolls the row back and surfaces a toast.
      await screen.findByText("readme.txt", {}, { timeout: 10_000 });
      await screen.findByText("Couldn't move to Trash");
    } finally {
      await harness.dispose();
    }
  });

  test("renaming appears immediately, and rolls back with a toast on failure", async () => {
    const harness = await harnessWithConnection([
      {
        urlContains: "renamed.txt",
        method: "PUT",
        action: { kind: "s3Error", status: 500, code: "InternalError", message: "boom" },
      },
    ]);
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));

      const dialog = await screen.findByRole("dialog");
      const nameInput = within(dialog).getByLabelText("Name");
      await user.clear(nameInput);
      await user.type(nameInput, "renamed.txt");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      // The dialog closes and the new name shows up immediately.
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await screen.findByText("renamed.txt");

      // The copy to the new key fails for real (faulted), so the rename
      // rolls back to the original name and toasts.
      await screen.findByText("readme.txt", {}, { timeout: 10_000 });
      expect(screen.queryByText("renamed.txt")).not.toBeInTheDocument();
      await screen.findByText("Couldn't rename");
    } finally {
      await harness.dispose();
    }
  });

  test("creating a new folder appears immediately, and rolls back with a toast on failure", async () => {
    const harness = await harnessWithConnection([
      {
        urlContains: "new-stuff/",
        method: "PUT",
        action: { kind: "s3Error", status: 500, code: "InternalError", message: "boom" },
      },
    ]);
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.click(screen.getByRole("button", { name: "New folder" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Name"), "new-stuff");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));

      // The dialog closes and the new folder shows up immediately.
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await screen.findByText("new-stuff");

      // The real create call fails (faulted), so it disappears again and toasts.
      await waitFor(() => expect(screen.queryByText("new-stuff")).not.toBeInTheDocument(), {
        timeout: 10_000,
      });
      await screen.findByText("Couldn't create folder");
    } finally {
      await harness.dispose();
    }
  });

  test("a mutation's silent reconcile never flips on the loading spinner state", async () => {
    // Only entry in the folder, so an optimistic delete drops entries to
    // zero — if the mutation's refresh used the spinner path, "This folder
    // is empty" would stay hidden until the (here, deliberately slow) real
    // delete call resolves. With the silent path, it shows immediately.
    const harness = await harnessWithConnection([
      { urlContains: "readme.txt", method: "DELETE", action: { kind: "stall", ms: 500 } },
    ]);
    try {
      await harness.bucket.put("readme.txt", "hello");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("readme.txt");

      await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));

      await screen.findByText("This folder is empty");
      // Stays that way once the (stalled) real delete finally resolves.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("a stale list response never overwrites a newer one", async () => {
    // A bespoke fault, not faultyFetch's: it needs to let the *request* fire
    // immediately (so it reads the bucket's true state at that instant) but
    // hold back *delivering the response* until released — reproducing a
    // slow listing response that lands after a faster, later one.
    let listCalls = 0;
    let releaseSecondCall: (() => void) | null = null;
    const releaseGate = new Promise<void>((resolve) => {
      releaseSecondCall = resolve;
    });
    function wrapFetch(inner: FetchFn): FetchFn {
      return async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        // "delimiter=" narrows this to the folder-browse listing (Delimiter:
        // "/" in listEntries) — the folder-info background effect also fires
        // ListObjectsV2 calls (for "photos/"'s stats), but recursively,
        // without a delimiter, so it never matches here.
        if (method === "GET" && url.includes("list-type=2") && url.includes("delimiter=")) {
          listCalls++;
          if (listCalls === 2) {
            const resultPromise = inner(input, init);
            await releaseGate;
            return resultPromise;
          }
        }
        return inner(input, init);
      };
    }

    const harness = await createServiceHarness({ wrapFetch });
    try {
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
      await harness.bucket.put("a.txt", "a");
      await harness.bucket.put("b.txt", "b");
      await harness.bucket.put("c.txt", "c");
      await harness.bucket.put("photos/marker", "");
      const user = userEvent.setup();

      renderBrowser(harness);
      await screen.findByText("a.txt"); // list call #1 — not stalled

      const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

      // First mutation kicks off refreshSilently's list call #2, which this
      // test holds open until told to release it.
      fireEvent.click(rowFor("a.txt"));
      fireEvent.contextMenu(rowFor("a.txt"));
      let menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));

      // Second mutation kicks off list call #3, which resolves normally —
      // and, since it's issued and answered after a.txt's own delete has
      // already landed in the bucket, reflects both removals.
      await screen.findByText("b.txt");
      fireEvent.click(rowFor("b.txt"));
      fireEvent.contextMenu(rowFor("b.txt"));
      menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: "Move to Trash" }));

      await waitFor(() => expect(screen.queryByText("b.txt")).not.toBeInTheDocument(), {
        timeout: 10_000,
      });

      // Now release the stale (2nd) response — it was sent while only
      // a.txt had been removed, but must be ignored because a newer
      // response (#3) already landed for this same listing.
      releaseSecondCall?.();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
      expect(screen.queryByText("b.txt")).not.toBeInTheDocument();
      expect(screen.getByText("c.txt")).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });
});
