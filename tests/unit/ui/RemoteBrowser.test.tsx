import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RemoteBrowser } from "../../../src/ui/RemoteBrowser";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { RemoteEntry } from "../../../src/lib/types";

afterEach(cleanup);

const ROOT_ENTRIES: RemoteEntry[] = [
  { kind: "folder", name: "photos", key: "photos/" },
  { kind: "file", name: "readme.txt", key: "readme.txt", size: 100, lastModified: 0 },
];
const PHOTOS_ENTRIES: RemoteEntry[] = [
  { kind: "file", name: "cat.png", key: "photos/cat.png", size: 2048, lastModified: 0 },
];

function Harness() {
  const [prefix, setPrefix] = useState("");
  return <RemoteBrowser connectionId="conn-1" prefix={prefix} onNavigate={setPrefix} />;
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
});
