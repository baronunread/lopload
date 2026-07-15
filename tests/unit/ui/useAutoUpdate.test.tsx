import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServicesProvider } from "../../../src/ui/services";
import { useAutoUpdate } from "../../../src/ui/useAutoUpdate";
import { createFakeServices } from "./fakeServices";
import type { Transfer } from "../../../src/lib/types";

afterEach(cleanup);

function Harness() {
  const { banner, phase, percent, startDownload, relaunch, dismiss } = useAutoUpdate();
  if (!banner) return <div>no banner</div>;
  return (
    <div>
      <div>{banner.title}</div>
      <div>{banner.body}</div>
      <div>phase: {phase}</div>
      <div>percent: {percent}</div>
      {banner.actionLabel && (
        <button onClick={phase === "ready" ? relaunch : startDownload}>
          {banner.actionLabel}
        </button>
      )}
      <button onClick={dismiss}>Dismiss</button>
    </div>
  );
}

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t1",
    connectionId: "conn-1",
    key: "clip.mp4",
    localPath: "/tmp/clip.mp4",
    size: 100,
    direction: "upload",
    state: { kind: "sending", percent: 10 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderHarness(services: ReturnType<typeof createFakeServices>) {
  render(
    <ServicesProvider value={services}>
      <Harness />
    </ServicesProvider>,
  );
}

describe("useAutoUpdate", () => {
  test("shows nothing when checkForUpdate finds nothing new", async () => {
    const services = createFakeServices({ updateVersion: null });
    renderHarness(services);
    await waitFor(() => expect(services.checkForUpdateCalls.length).toBe(1));
    expect(screen.getByText("no banner")).toBeInTheDocument();
  });

  test("surfaces an Update action in the available phase when a version is found", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9" });
    renderHarness(services);
    await screen.findByText("Version 9.9.9 is available");
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  test("Update downloads, then offers Restart now, which relaunches", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9", updateDownloadSteps: [100] });
    renderHarness(services);

    const update = await screen.findByRole("button", { name: "Update" });
    await userEvent.click(update);

    // Download ran and the flow advanced to the ready phase.
    expect(services.downloadUpdateCalls.length).toBe(1);
    const restart = await screen.findByRole("button", { name: "Restart now" });

    await userEvent.click(restart);
    expect(services.relaunchAppCalls.length).toBe(1);
  });

  test("ready-phase copy warns when a transfer is in flight, without hiding restart", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9", updateDownloadSteps: [100] });
    renderHarness(services);

    act(() => {
      services.emit({ type: "transfer-updated", transfer: makeTransfer() });
    });

    const update = await screen.findByRole("button", { name: "Update" });
    await userEvent.click(update);

    await screen.findByRole("button", { name: "Restart now" });
    expect(screen.getByText((t) => t.includes("interrupt"))).toBeInTheDocument();
  });

  test("dismiss hides the banner", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9" });
    renderHarness(services);

    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    await userEvent.click(dismiss);
    await screen.findByText("no banner");
  });
});
