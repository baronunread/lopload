import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Toasty } from "@cloudflare/kumo";
import { SetupForm } from "../../../src/ui/SetupForm";
import { Onboarding } from "../../../src/ui/Onboarding";
import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { TransferWidget } from "../../../src/ui/TransferWidget";
import { ConnectionSwitcher } from "../../../src/ui/ConnectionSwitcher";
import { StatusChip } from "../../../src/ui/StatusChip";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Connection, RemoteEntry, Transfer, TransferState } from "../../../src/lib/types";

afterEach(cleanup);

const BANNED = [/bucket/i, /object key/i, /\bprefix\b/i, /etag/i];

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
    direction: "upload",
    state: { kind: "failed", errorClass: "storage-full" },
    createdAt: 0,
    updatedAt: 0,
  },
];

describe("jargon sweep", () => {
  test("no rendered screen ever says bucket/object key/prefix/ETag", () => {
    const services = createFakeServices({
      connections: [conn],
      entriesByPrefix: { "conn-1::": entries },
      transfersByConnection: { "conn-1": transfers },
    });

    const onboarding = render(
      <Toasty>
        <ServicesProvider value={services}>
          <Onboarding onDone={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );
    assertNoJargon(onboarding.container);
    onboarding.unmount();

    const setup = render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupForm onSaved={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );
    assertNoJargon(setup.container);
    setup.unmount();

    const browser = render(
      <Toasty>
        <ServicesProvider value={services}>
          <RemoteBrowser connectionId="conn-1" prefix="" onNavigate={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );
    assertNoJargon(browser.container);
    browser.unmount();

    const widget = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );
    assertNoJargon(widget.container);
    widget.unmount();

    const switcher = render(
      <ConnectionSwitcher
        connections={[conn]}
        currentId={conn.id}
        onSwitch={() => {}}
        onAddStorage={() => {}}
        onManageStorage={() => {}}
      />,
    );
    assertNoJargon(switcher.container);
    switcher.unmount();

    const states: TransferState[] = [
      { kind: "queued" },
      { kind: "sending", percent: 10 },
      { kind: "checking" },
      { kind: "uploaded" },
      { kind: "downloaded" },
      { kind: "failed", errorClass: "verification" },
    ];
    for (const state of states) {
      for (const direction of ["upload", "download"] as const) {
        const chip = render(<StatusChip state={state} direction={direction} />);
        assertNoJargon(chip.container);
        chip.unmount();
      }
    }
  });
});
