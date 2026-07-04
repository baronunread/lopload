import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { SetupScreen } from "../../../src/ui/SetupScreen";
import { WelcomeScreen } from "../../../src/ui/WelcomeScreen";
import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { TransferPanel } from "../../../src/ui/TransferPanel";
import { ConnectionSwitcher } from "../../../src/ui/ConnectionSwitcher";
import { StatusChip } from "../../../src/ui/StatusChip";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Connection, RemoteEntry, Transfer, TransferState } from "../../../src/lib/types";

afterEach(cleanup);

const BANNED = [/bucket/i, /object key/i, /\bprefix\b/i, /multipart/i, /etag/i];

function assertNoJargon(container: HTMLElement) {
  const text = container.textContent ?? "";
  for (const pattern of BANNED) {
    expect(text).not.toMatch(pattern);
  }
}

const conn: Connection = {
  id: "conn-1",
  name: "Videos",
  endpoint: "https://example.test",
  bucket: "videos-bucket",
  lastPrefix: "",
  createdAt: 0,
};

const entries: RemoteEntry[] = [
  { kind: "folder", name: "photos", key: "photos/" },
  { kind: "file", name: "clip.mp4", key: "clip.mp4", size: 100, lastModified: 0 },
];

const transfers: Transfer[] = [
  {
    id: "t1",
    connectionId: "conn-1",
    key: "clip.mp4",
    localPath: "/tmp/clip.mp4",
    size: 100,
    partSize: 8 * 1024 * 1024,
    state: { kind: "failed", errorClass: "storage-full" },
    createdAt: 0,
    updatedAt: 0,
  },
];

describe("jargon sweep", () => {
  test("no rendered screen ever says bucket/object key/prefix/multipart/ETag", () => {
    const services = createFakeServices({
      connections: [conn],
      entriesByPrefix: { "conn-1::": entries },
      transfersByConnection: { "conn-1": transfers },
    });

    const welcome = render(<WelcomeScreen onGetStarted={() => {}} />);
    assertNoJargon(welcome.container);
    welcome.unmount();

    const setup = render(
      <ServicesProvider value={services}>
        <SetupScreen onSaved={() => {}} />
      </ServicesProvider>,
    );
    assertNoJargon(setup.container);
    setup.unmount();

    const browser = render(
      <ServicesProvider value={services}>
        <RemoteBrowser connectionId="conn-1" prefix="" onNavigate={() => {}} />
      </ServicesProvider>,
    );
    assertNoJargon(browser.container);
    browser.unmount();

    const panel = render(
      <ServicesProvider value={services}>
        <TransferPanel connectionId="conn-1" prefix="" />
      </ServicesProvider>,
    );
    assertNoJargon(panel.container);
    panel.unmount();

    const switcher = render(
      <ConnectionSwitcher
        connections={[conn]}
        currentId={conn.id}
        onSwitch={() => {}}
        onAddStorage={() => {}}
      />,
    );
    assertNoJargon(switcher.container);
    switcher.unmount();

    const states: TransferState[] = [
      { kind: "queued" },
      { kind: "sending", percent: 10 },
      { kind: "checking" },
      { kind: "uploaded" },
      { kind: "failed", errorClass: "verification" },
    ];
    for (const state of states) {
      const chip = render(<StatusChip state={state} />);
      assertNoJargon(chip.container);
      chip.unmount();
    }
  });
});
