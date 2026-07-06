import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";
import { Toasty } from "@cloudflare/kumo";
import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { RemoteEntry, Transfer } from "../../../src/lib/types";

afterEach(cleanup);

const ROOT_ENTRIES: RemoteEntry[] = [
  { kind: "folder", name: "photos", key: "photos/" },
  { kind: "file", name: "readme.txt", key: "readme.txt", size: 100, lastModified: 0 },
];
const PHOTOS_ENTRIES: RemoteEntry[] = [
  { kind: "file", name: "cat.png", key: "photos/cat.png", size: 2048, lastModified: 0 },
];
const MANY_ENTRIES: RemoteEntry[] = [
  { kind: "folder", name: "photos", key: "photos/" },
  { kind: "file", name: "a.txt", key: "a.txt", size: 1, lastModified: 0 },
  { kind: "file", name: "b.txt", key: "b.txt", size: 1, lastModified: 0 },
  { kind: "file", name: "c.txt", key: "c.txt", size: 1, lastModified: 0 },
];

function Harness() {
  const [prefix, setPrefix] = useState("");
  return (
    <Toasty>
      <RemoteBrowser connectionId="conn-1" prefix={prefix} onNavigate={setPrefix} />
    </Toasty>
  );
}

/** Minimal DataTransfer stand-in — jsdom doesn't implement the real one, but
 * fireEvent happily accepts anything shaped like it as the event's payload. */
function makeDataTransfer() {
  const store = new Map<string, string>();
  const types: string[] = [];
  return {
    effectAllowed: "none",
    dropEffect: "none",
    types,
    setData(type: string, value: string) {
      if (!types.includes(type)) types.push(type);
      store.set(type, value);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

describe("RemoteBrowser", () => {
  test("breadcrumb navigation updates the listing and calls setLastPrefix", async () => {
    const services = createFakeServices({
      entriesByPrefix: {
        "conn-1::": ROOT_ENTRIES,
        "conn-1::photos/": PHOTOS_ENTRIES,
      },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );

    await screen.findByText("readme.txt");

    // Enter the "photos" folder via double-click.
    await user.dblClick(screen.getByText("photos"));
    await screen.findByText("cat.png");
    expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
    expect(services.setLastPrefixCalls).toContainEqual({ id: "conn-1", prefix: "photos/" });

    // Breadcrumb "Home" navigates back to root. Kumo's Breadcrumbs renders a
    // duplicate mobile/desktop pair, so pick the first match.
    await user.click(screen.getAllByText("Home")[0]);
    await screen.findByText("readme.txt");
    expect(services.setLastPrefixCalls).toContainEqual({ id: "conn-1", prefix: "" });
  });

  test("shows an empty state when a folder has no entries", async () => {
    const services = createFakeServices({ entriesByPrefix: { "conn-1::": [] } });
    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("This folder is empty");
  });

  test("the per-row '⋯' touch trigger opens the same context menu as right-click", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": ROOT_ENTRIES },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );

    await screen.findByText("readme.txt");

    // No menu open yet.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));

    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    // Entry-specific actions (only shown when a row entry is targeted).
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  test("re-lists the current folder once an upload finishes", async () => {
    const entriesByPrefix: Record<string, RemoteEntry[]> = { "conn-1::": [] };
    const services = createFakeServices({ entriesByPrefix });

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("This folder is empty");

    // The backend now has the uploaded file; only the engine event should
    // prompt the browser to notice, without the user navigating away.
    entriesByPrefix["conn-1::"] = ROOT_ENTRIES;
    const transfer: Transfer = {
      id: "t1",
      connectionId: "conn-1",
      key: "readme.txt",
      localPath: "/tmp/readme.txt",
      size: 100,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "uploaded" },
      createdAt: 0,
      updatedAt: 0,
    };
    services.emit({ type: "transfer-updated", transfer });

    await screen.findByText("readme.txt", {}, { timeout: 2000 });
  });

  test("double-clicking a file opens it with the default app; folders still navigate", async () => {
    const services = createFakeServices({
      entriesByPrefix: {
        "conn-1::": ROOT_ENTRIES,
        "conn-1::photos/": PHOTOS_ENTRIES,
      },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("readme.txt");

    await user.dblClick(screen.getByText("readme.txt"));
    expect(services.openFileCalls).toEqual([
      { connectionId: "conn-1", key: "readme.txt", name: "readme.txt" },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Folders still navigate on double-click, without opening anything.
    await user.dblClick(screen.getByText("photos"));
    await screen.findByText("cat.png");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the context menu offers a 'File info' item that opens the same debug dialog", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": ROOT_ENTRIES },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("readme.txt");

    await user.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "File info" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "File info" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/File info/)).toBeInTheDocument();
  });

  test("dragging a row onto a folder row moves it via the browser service", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": ROOT_ENTRIES },
    });

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("readme.txt");

    const fileRow = screen.getByText("readme.txt").closest("tr");
    const folderRow = screen.getByText("photos").closest("tr");
    expect(fileRow).toBeTruthy();
    expect(folderRow).toBeTruthy();

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(fileRow as HTMLElement, { dataTransfer });
    fireEvent.dragEnter(folderRow as HTMLElement, { dataTransfer });
    fireEvent.drop(folderRow as HTMLElement, { dataTransfer });

    await screen.findByText("readme.txt"); // still rendered while the move resolves
    expect(services.moveCalls).toContainEqual({
      connectionId: "conn-1",
      key: "readme.txt",
      toKey: "photos/readme.txt",
    });
  });

  test("shift-click extends a range selection, and dragging any selected row moves the whole selection", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": MANY_ENTRIES },
    });

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("a.txt");

    const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

    // Select a.txt, then shift-click c.txt: selects a, b, c (not the "photos" folder).
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(rowFor("c.txt"), { shiftKey: true });

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor("b.txt"), { dataTransfer });
    fireEvent.dragEnter(rowFor("photos"), { dataTransfer });
    fireEvent.drop(rowFor("photos"), { dataTransfer });

    await waitFor(() => {
      expect(services.moveCalls).toContainEqual({
        connectionId: "conn-1",
        key: "a.txt",
        toKey: "photos/a.txt",
      });
      expect(services.moveCalls).toContainEqual({
        connectionId: "conn-1",
        key: "b.txt",
        toKey: "photos/b.txt",
      });
      expect(services.moveCalls).toContainEqual({
        connectionId: "conn-1",
        key: "c.txt",
        toKey: "photos/c.txt",
      });
    });
  });

  test("cmd/ctrl-click toggles rows independently, and Escape clears the whole selection", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": MANY_ENTRIES },
    });

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("a.txt");

    const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

    // cmd-click both a.txt and b.txt into the selection.
    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(rowFor("b.txt"), { metaKey: true });

    // Escape clears the selection entirely.
    fireEvent.keyDown(document, { key: "Escape" });

    // Dragging a.txt now moves only itself — if Escape hadn't cleared the
    // two-row selection, this would have moved b.txt along with it.
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowFor("a.txt"), { dataTransfer });
    fireEvent.dragEnter(rowFor("photos"), { dataTransfer });
    fireEvent.drop(rowFor("photos"), { dataTransfer });

    await waitFor(() => {
      expect(services.moveCalls).toEqual([
        { connectionId: "conn-1", key: "a.txt", toKey: "photos/a.txt" },
      ]);
    });
  });

  test("right-clicking a row within a multi-selection offers bulk delete, pluralized", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": MANY_ENTRIES },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("a.txt");

    const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

    fireEvent.click(rowFor("a.txt"));
    fireEvent.click(rowFor("c.txt"), { shiftKey: true }); // selects a, b, c

    fireEvent.contextMenu(rowFor("b.txt"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Delete 3 items" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 3 items?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect([...services.deleteCalls].sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    });
  });

  test("bulk download on a multi-selection enqueues files directly and folders recursively", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": MANY_ENTRIES },
      downloadDirectoryResult: "/dest",
      filesRecursiveByPrefix: {
        "conn-1::photos/": [
          { key: "photos/cat.png", size: 2048 },
          { key: "photos/2024/dog.png", size: 4096 },
        ],
      },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("a.txt");

    const rowFor = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

    fireEvent.click(rowFor("photos"));
    fireEvent.click(rowFor("a.txt"), { metaKey: true });

    fireEvent.contextMenu(rowFor("a.txt"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Download 2 items" }));

    await waitFor(() => expect(services.enqueueDownloadsCalls.length).toBe(1));
    const { connectionId, targets } = services.enqueueDownloadsCalls[0];
    expect(connectionId).toBe("conn-1");
    expect(targets).toEqual([
      { key: "photos/cat.png", localPath: "/dest/photos/cat.png", size: 2048 },
      { key: "photos/2024/dog.png", localPath: "/dest/photos/2024/dog.png", size: 4096 },
      { key: "a.txt", localPath: "/dest/a.txt", size: 1 },
    ]);
  });

  test("the folder info dialog shows a loading state, then the computed size and last-changed date", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": ROOT_ENTRIES },
      folderInfoResult: {
        files: 3,
        totalSize: 5_000_000,
        lastModified: new Date("2024-01-02").getTime(),
      },
    });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("readme.txt");

    await user.click(screen.getByRole("button", { name: "Actions for photos" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Folder info" }));

    const dialog = await screen.findByRole("dialog");
    // The fake service resolves near-instantly, so the loading state isn't
    // reliably observable here — the real assertion is the computed result.
    await within(dialog).findByText(/3 files, 4\.8 MB, last changed/);
    expect(services.folderInfoCalls).toContainEqual({ connectionId: "conn-1", key: "photos/" });
  });

  test("shows an error toast when the file-drop handler reports an error", async () => {
    const services = createFakeServices({
      entriesByPrefix: { "conn-1::": ROOT_ENTRIES },
    });

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("readme.txt");

    // Unlike userEvent/fireEvent helpers, this calls the registered onFileDrop
    // error callback directly — React 19 asserts on state updates triggered
    // outside its own event handling, so the resulting setDragging + toast
    // updates need an explicit act() wrapper.
    act(() => {
      services.triggerFileDropError("permission denied");
    });

    await screen.findByText(/Some of what you dropped couldn't be added/);
    await screen.findByText(/permission denied/);
  });

  test("clicking the Size header sorts files by size, folders always first", async () => {
    const SORT_ENTRIES: RemoteEntry[] = [
      { kind: "folder", name: "zzz-folder", key: "zzz-folder/" },
      { kind: "file", name: "big.bin", key: "big.bin", size: 3000, lastModified: 0 },
      { kind: "file", name: "small.bin", key: "small.bin", size: 10, lastModified: 0 },
      { kind: "file", name: "mid.bin", key: "mid.bin", size: 500, lastModified: 0 },
    ];
    const services = createFakeServices({ entriesByPrefix: { "conn-1::": SORT_ENTRIES } });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
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
  });

  test("the filter field narrows rows by name, and Escape clears it before the selection", async () => {
    const services = createFakeServices({ entriesByPrefix: { "conn-1::": MANY_ENTRIES } });
    const user = userEvent.setup();

    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
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

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(screen.getByText("a.txt").closest("tr") as HTMLElement, { dataTransfer });
    fireEvent.dragEnter(screen.getByText("photos").closest("tr") as HTMLElement, { dataTransfer });
    fireEvent.drop(screen.getByText("photos").closest("tr") as HTMLElement, { dataTransfer });

    await waitFor(() => {
      expect(services.moveCalls).toContainEqual({
        connectionId: "conn-1",
        key: "a.txt",
        toKey: "photos/a.txt",
      });
    });

    // A second Escape (filter already empty) clears the selection.
    fireEvent.click(screen.getByText("b.txt").closest("tr") as HTMLElement);
    fireEvent.keyDown(document, { key: "Escape" });
    const dataTransfer2 = makeDataTransfer();
    fireEvent.dragStart(screen.getByText("c.txt").closest("tr") as HTMLElement, { dataTransfer: dataTransfer2 });
    fireEvent.dragEnter(screen.getByText("photos").closest("tr") as HTMLElement, { dataTransfer: dataTransfer2 });
    fireEvent.drop(screen.getByText("photos").closest("tr") as HTMLElement, { dataTransfer: dataTransfer2 });

    await waitFor(() => {
      expect(services.moveCalls).toContainEqual({
        connectionId: "conn-1",
        key: "c.txt",
        toKey: "photos/c.txt",
      });
    });
    expect(services.moveCalls).not.toContainEqual({
      connectionId: "conn-1",
      key: "b.txt",
      toKey: "photos/b.txt",
    });
  });
});
