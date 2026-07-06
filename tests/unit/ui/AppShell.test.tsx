import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "../../../src/ui/AppShell";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Connection, RemoteEntry, Transfer } from "../../../src/lib/types";

afterEach(cleanup);

const videos: Connection = {
  id: "videos",
  name: "Videos",
  endpoint: "https://videos.example.test",
  bucket: "videos-bucket",
  lastPrefix: "clips/",
  createdAt: 0,
};
const documents: Connection = {
  id: "documents",
  name: "Documents",
  endpoint: "https://docs.example.test",
  bucket: "docs-bucket",
  lastPrefix: "",
  createdAt: 0,
};

const videosClipsEntries: RemoteEntry[] = [
  { kind: "file", name: "vacation.mp4", key: "clips/vacation.mp4", size: 100, lastModified: 0 },
];
const documentsRootEntries: RemoteEntry[] = [
  { kind: "file", name: "invoice.pdf", key: "invoice.pdf", size: 50, lastModified: 0 },
];

const videosTransfer: Transfer = {
  id: "t-videos",
  connectionId: "videos",
  key: "clips/vacation.mp4",
  localPath: "/tmp/vacation.mp4",
  size: 100,
  partSize: 8 * 1024 * 1024,
  direction: "upload",
  state: { kind: "sending", percent: 50 },
  createdAt: 0,
  updatedAt: 0,
};
const documentsTransfer: Transfer = {
  id: "t-docs",
  connectionId: "documents",
  key: "invoice.pdf",
  localPath: "/tmp/invoice.pdf",
  size: 50,
  partSize: 8 * 1024 * 1024,
  direction: "upload",
  // Sticky failures stay visible across a connection switch; a plain
  // "uploaded" transfer would not — see the regression test in
  // TransferWidget.test.tsx documenting why (historical completed
  // transfers must never resurface the widget on their own).
  state: { kind: "failed", errorClass: "offline" },
  createdAt: 0,
  updatedAt: 0,
};

describe("AppShell first run", () => {
  test("zero connections shows the onboarding with the connection form", async () => {
    const services = createFakeServices({ connections: [] });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    // Onboarding step 1: welcome copy and the setup form together.
    await waitFor(() =>
      expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Access key")).toBeInTheDocument();
  });
});

describe("AppShell connection switcher", () => {
  test("switching connections resets the browser to that connection's lastPrefix and isolates transfers", async () => {
    const services = createFakeServices({
      connections: [videos, documents],
      entriesByPrefix: {
        "videos::clips/": videosClipsEntries,
        "documents::": documentsRootEntries,
      },
      transfersByConnection: {
        videos: [videosTransfer],
        documents: [documentsTransfer],
      },
    });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    // Starts on the first connection (Videos), at its remembered folder.
    // The file name appears twice — once in the browser table, once in the
    // transfer list — so we use getAllByText throughout this test.
    await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));
    expect(screen.getByText("Sending — 50%")).toBeInTheDocument();
    expect(screen.queryByText("invoice.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't send — tap to retry")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Storage connection"));
    await user.click(screen.getByRole("option", { name: "Documents" }));

    // Now shows Documents' own folder and transfers — no state mixing.
    await waitFor(() =>
      expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("Couldn't send — tap to retry")).toBeInTheDocument();
    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("Sending — 50%")).not.toBeInTheDocument();
  });
});

describe("AppShell manage connections", () => {
  test("removing the active connection falls back to another remaining one", async () => {
    const services = createFakeServices({
      connections: [videos, documents],
      entriesByPrefix: {
        "videos::clips/": videosClipsEntries,
        "documents::": documentsRootEntries,
      },
    });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Storage connection"));
    await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

    await screen.findByText("Storage connections");
    await user.click(screen.getByRole("button", { name: "Remove Videos" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    // Falls back to the only remaining connection, Documents, with no
    // leftover trace of Videos' state.
    await waitFor(() => expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0));
    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
    expect(await services.connections.list()).toEqual([documents]);
  });

  test("deleting the active connection never resurrects the fallback connection's old, already-uploaded transfers", async () => {
    // Regression: deleting a connection switches `currentId` to the
    // fallback connection just like an explicit switch does. If the
    // fallback happens to have a finished upload sitting in its history,
    // the floating widget must not pop up out of nowhere for it — the
    // widget should only ever appear for uploads enqueued while it's
    // mounted, not historical completed ones surfaced by a connection
    // change.
    const services = createFakeServices({
      connections: [videos, documents],
      entriesByPrefix: {
        "videos::clips/": videosClipsEntries,
        "documents::": documentsRootEntries,
      },
      transfersByConnection: {
        documents: [{ ...documentsTransfer, state: { kind: "uploaded" } }],
      },
    });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Storage connection"));
    await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

    await screen.findByText("Storage connections");
    await user.click(screen.getByRole("button", { name: "Remove Videos" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Uploading \d+ item/)).not.toBeInTheDocument();
    expect(screen.queryByText(/uploads? complete/)).not.toBeInTheDocument();
  });

  test("removing the last connection returns to the onboarding", async () => {
    const services = createFakeServices({ connections: [videos] });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    const user = userEvent.setup();
    await screen.findByLabelText("Storage connection");
    await user.click(screen.getByLabelText("Storage connection"));
    await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

    await screen.findByText("Storage connections");
    await user.click(screen.getByRole("button", { name: "Remove Videos" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument(),
    );
  });
});
