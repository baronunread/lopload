import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServicesProvider } from "../../../src/ui/services";
import { useAutoUpdate } from "../../../src/ui/useAutoUpdate";
import { createFakeServices } from "./fakeServices";
import type { Transfer } from "../../../src/lib/types";

afterEach(cleanup);

function Harness() {
  const { notice, installAndRelaunch, dismiss } = useAutoUpdate();
  if (!notice) return <div>no notice</div>;
  return (
    <div>
      <div>{notice.body}</div>
      <button onClick={installAndRelaunch}>{notice.actionLabel}</button>
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

describe("useAutoUpdate", () => {
  test("shows nothing when checkForUpdate finds nothing new", async () => {
    const services = createFakeServices({ updateVersion: null });
    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await waitFor(() => expect(services.checkForUpdateCalls.length).toBe(1));
    expect(screen.getByText("no notice")).toBeInTheDocument();
  });

  test("shows the plain restart notice when no transfers are in flight", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9" });
    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("Restart to update.");
  });

  test("warns about in-flight transfers being interrupted instead of hiding the restart action", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9" });
    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );
    await screen.findByText("Restart to update.");

    act(() => {
      services.emit({ type: "transfer-updated", transfer: makeTransfer() });
    });

    const button = await screen.findByRole("button", { name: "Restart and update" });
    expect(screen.getByText((text) => text.includes("will be interrupted"))).toBeInTheDocument();
    expect(button).toBeInTheDocument();
  });

  test("installAndRelaunch and dismiss both work from the notice", async () => {
    const services = createFakeServices({ updateVersion: "9.9.9" });
    render(
      <ServicesProvider value={services}>
        <Harness />
      </ServicesProvider>,
    );

    const install = await screen.findByRole("button", { name: "Restart and update" });
    await userEvent.click(install);
    expect(services.installAndRelaunchCalls.length).toBe(1);

    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    await userEvent.click(dismiss);
    await screen.findByText("no notice");
  });
});
