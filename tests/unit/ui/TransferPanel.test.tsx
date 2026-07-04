import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransferPanel } from "../../../src/ui/TransferPanel";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Transfer } from "../../../src/lib/types";

afterEach(cleanup);

function makeTransfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: "t1",
    connectionId: "conn-1",
    key: "photos/cat.png",
    localPath: "/tmp/cat.png",
    size: 1024,
    partSize: 8 * 1024 * 1024,
    state: { kind: "queued" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("TransferPanel", () => {
  test("failed chip stays rendered after other transfers complete, until explicit dismiss", async () => {
    const uploaded = makeTransfer({ id: "ok-1", key: "a.png", state: { kind: "sending", percent: 10 } });
    const failed = makeTransfer({
      id: "fail-1",
      key: "b.png",
      state: { kind: "failed", errorClass: "offline" },
    });
    const services = createFakeServices({
      transfersByConnection: { "conn-1": [uploaded, failed] },
    });

    render(
      <ServicesProvider value={services}>
        <TransferPanel connectionId="conn-1" prefix="" />
      </ServicesProvider>,
    );

    await screen.findByText("Couldn't send — tap to retry");

    // The other transfer finishes...
    services.emit({
      type: "transfer-updated",
      transfer: { ...uploaded, state: { kind: "uploaded" } },
    });

    await waitFor(() => expect(screen.getByText("Uploaded ✓")).toBeInTheDocument());
    // ...but the failed one is still there, untouched.
    expect(screen.getByText("Couldn't send — tap to retry")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("Couldn't send — tap to retry"));
    expect(services.retryCalls).toEqual(["fail-1"]);
    // Retrying doesn't dismiss it — only the explicit X does.
    expect(screen.getByText("Couldn't send — tap to retry")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Dismiss b.png"));
    expect(services.dismissCalls).toEqual(["fail-1"]);
    await waitFor(() =>
      expect(screen.queryByText("Couldn't send — tap to retry")).not.toBeInTheDocument(),
    );
  });

  test("surfaces failed count to services.setBadgeCount", async () => {
    const failed = makeTransfer({
      id: "fail-1",
      state: { kind: "failed", errorClass: "offline" },
    });
    const services = createFakeServices({
      transfersByConnection: { "conn-1": [failed] },
    });

    render(
      <ServicesProvider value={services}>
        <TransferPanel connectionId="conn-1" prefix="" />
      </ServicesProvider>,
    );

    await screen.findByText("Couldn't send — tap to retry");
    await waitFor(() => expect(services.badgeCounts.at(-1)).toBe(1));
  });
});
