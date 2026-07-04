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
  state: { kind: "uploaded" },
  createdAt: 0,
  updatedAt: 0,
};

describe("AppShell first run", () => {
  test("zero connections shows the welcome screen, then the setup form after the CTA", async () => {
    const services = createFakeServices({ connections: [] });

    render(
      <ServicesProvider value={services}>
        <AppShell />
      </ServicesProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Drag files in, watch them upload, know for certain they arrived."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Endpoint URL")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add a storage connection" }));

    expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Access key")).toBeInTheDocument();
    expect(
      screen.queryByText("Drag files in, watch them upload, know for certain they arrived."),
    ).not.toBeInTheDocument();
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
    expect(screen.queryByText("Uploaded ✓")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Storage connection"));
    await user.click(screen.getByRole("option", { name: "Documents" }));

    // Now shows Documents' own folder and transfers — no state mixing.
    await waitFor(() =>
      expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("Uploaded ✓")).toBeInTheDocument();
    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("Sending — 50%")).not.toBeInTheDocument();
  });
});
