import { afterEach, describe, expect, test, vi } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransferWidget } from "../../../src/ui/TransferWidget";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Transfer } from "../../../src/lib/types";

afterEach(cleanup);

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t1",
    connectionId: "conn-1",
    key: "clips/vacation.mp4",
    localPath: "/tmp/vacation.mp4",
    size: 100,
    partSize: 8 * 1024 * 1024,
    direction: "upload",
    state: { kind: "sending", percent: 40 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("TransferWidget", () => {
  test("renders nothing when there are no transfers, then appears when one starts", async () => {
    const services = createFakeServices({ connections: [] });
    const { container } = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    // No transfers → the widget stays out of the tree entirely.
    await waitFor(() => expect(container.textContent).toBe(""));

    act(() => {
      services.emit({ type: "transfer-updated", transfer: makeTransfer() });
    });

    await screen.findByText("Uploading 1 item…");
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
  });

  test("ignores transfers belonging to other connections", async () => {
    const services = createFakeServices({ connections: [] });
    const { container } = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ connectionId: "other" }),
      });
    });

    await waitFor(() => expect(container.textContent).toBe(""));
  });

  test("does not resurface historical, already-uploaded transfers on load", async () => {
    // Regression: switching to a connection whose store already contains
    // finished uploads from a past session must not pop the widget open.
    const services = createFakeServices({
      transfersByConnection: {
        "conn-1": [makeTransfer({ state: { kind: "uploaded" } })],
      },
    });
    const { container } = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    await waitFor(() => expect(container.textContent).toBe(""));
  });

  test("title switches from 'Uploading…' to a completion summary once everything finishes", async () => {
    const services = createFakeServices({ connections: [] });
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ state: { kind: "sending", percent: 50 } }),
      });
    });
    await screen.findByText("Uploading 1 item…");

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ state: { kind: "uploaded" } }),
      });
    });
    await screen.findByText("1 upload complete");
  });

  test("title reports partial completion when some uploads failed", async () => {
    const services = createFakeServices({ connections: [] });
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ id: "t1", state: { kind: "uploaded" } }),
      });
    });
    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({
          id: "t2",
          key: "clips/other.mp4",
          state: { kind: "failed", errorClass: "offline" },
        }),
      });
    });

    await screen.findByText("1 of 2 uploads complete");
  });

  test("collapsing hides the transfer list but keeps the title", async () => {
    const services = createFakeServices({
      transfersByConnection: { "conn-1": [makeTransfer()] },
    });
    const user = userEvent.setup();
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    await screen.findByText("vacation.mp4");
    await user.click(screen.getByRole("button", { name: "Collapse transfers" }));

    expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
    expect(screen.getByText("Uploading 1 item…")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand transfers" }));
    expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
  });

  test("failed transfers are sticky, retryable, and dismissible", async () => {
    const failed = makeTransfer({ state: { kind: "failed", errorClass: "connection-dropped" } });
    const services = createFakeServices({
      transfersByConnection: { "conn-1": [failed] },
    });
    const user = userEvent.setup();
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    await screen.findByText("0 of 1 uploads complete");
    // Failed count feeds the dock badge.
    await waitFor(() => expect(services.badgeCounts).toContain(1));

    await user.click(screen.getByLabelText(/click to retry/));
    expect(services.retryCalls).toEqual(["t1"]);

    await user.click(screen.getByLabelText(`Dismiss ${failed.key}`));
    expect(services.dismissCalls).toEqual(["t1"]);
    // Widget disappears once its last transfer is dismissed.
    await waitFor(() =>
      expect(screen.queryByText("0 of 1 uploads complete")).not.toBeInTheDocument(),
    );
  });

  test("the close button clears everything and hides the widget", async () => {
    const services = createFakeServices({
      transfersByConnection: {
        "conn-1": [makeTransfer({ id: "t1", state: { kind: "failed", errorClass: "offline" } })],
      },
    });
    const user = userEvent.setup();
    const { container } = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    await screen.findByText("0 of 1 uploads complete");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(services.dismissCalls).toEqual(["t1"]);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  test("never auto-dismisses, even long after every transfer succeeds", async () => {
    const services = createFakeServices({ connections: [] });
    const { container } = render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ state: { kind: "sending", percent: 50 } }),
      });
    });
    expect(screen.getByText("Uploading 1 item…")).toBeInTheDocument();

    vi.useFakeTimers();
    try {
      act(() => {
        services.emit({
          type: "transfer-updated",
          transfer: makeTransfer({ state: { kind: "uploaded" } }),
        });
      });
      expect(screen.getByText("1 upload complete")).toBeInTheDocument();

      // Advance well past the old 4s auto-dismiss timer (and its exit
      // animation) — the widget must still be there since it no longer
      // dismisses itself.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(container.textContent).not.toBe("");
    expect(screen.getByText("1 upload complete")).toBeInTheDocument();
  });

  test("stays visible and does not auto-dismiss when a transfer fails", async () => {
    const services = createFakeServices({ connections: [] });
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" />
      </ServicesProvider>,
    );

    act(() => {
      services.emit({
        type: "transfer-updated",
        transfer: makeTransfer({ state: { kind: "failed", errorClass: "offline" } }),
      });
    });
    expect(screen.getByText("0 of 1 uploads complete")).toBeInTheDocument();

    vi.useFakeTimers();
    try {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText("0 of 1 uploads complete")).toBeInTheDocument();
  });

  test("finished batches notify with a plain-language summary", async () => {
    const services = createFakeServices({
      transfersByConnection: { "conn-1": [makeTransfer({ state: { kind: "sending", percent: 10 } })] },
    });
    const summaries: string[] = [];
    render(
      <ServicesProvider value={services}>
        <TransferWidget connectionId="conn-1" onBatchFinished={(s) => summaries.push(s)} />
      </ServicesProvider>,
    );

    await screen.findByText("Uploading 1 item…");
    act(() => {
      services.emit({ type: "batch-finished", uploaded: 2, downloaded: 0, failed: 1 });
    });

    await waitFor(() => expect(summaries).toEqual(["2 files uploaded, 1 file failed"]));
    expect(services.notifications).toEqual([
      { title: "Lopload", body: "2 files uploaded, 1 file failed" },
    ]);
  });
});
