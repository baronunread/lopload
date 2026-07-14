import "../../support/noActEnv";

import { afterEach, describe, expect, test as bunTest, vi } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFile } from "node:fs/promises";

import { TransferWidget } from "../../../src/ui/TransferWidget";
import { ServicesProvider } from "../../../src/ui/services";
import { faultyFetch, type Fault } from "../../support/faultyFetch";
import { createServiceHarness, type ServiceHarness } from "../../support/serviceHarness";
import type { EngineEvent } from "../../../src/lib/types";

afterEach(cleanup);

const CONN = "conn-1";

async function harnessWithConnection(faults: Fault[] = []): Promise<ServiceHarness> {
  const harness = await createServiceHarness(
    faults.length > 0 ? { wrapFetch: (inner) => faultyFetch(inner, faults) } : {},
  );
  await harness.services.connections.save(
    {
      id: CONN,
      name: "Test",
      endpoint: harness.bucketConnection.endpoint,
      bucket: harness.bucketConnection.bucket,
      region: harness.bucketConnection.region,
      lastPrefix: "",
      createdAt: Date.now(),
    },
    harness.credentials,
  );
  return harness;
}

async function localFile(harness: ServiceHarness, name: string, size = 4): Promise<{ path: string; size: number }> {
  const path = `${harness.workdir}/${name}`;
  const bytes = new Uint8Array(size).fill(7);
  await writeFile(path, bytes);
  return { path, size };
}

/** Waits for an EngineEvent matching `check` to fire on this connection's engine. */
function waitForEvent(
  harness: ServiceHarness,
  check: (event: EngineEvent) => boolean,
  timeoutMs = 15_000,
): Promise<EngineEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("event never fired")), timeoutMs);
    const unsub = harness.services.engine.subscribe((event) => {
      if (!check(event)) return;
      clearTimeout(timer);
      unsub();
      resolve(event);
    });
  });
}

describe("TransferWidget", () => {
  // Real MinIO + real transfers take longer than bun's 5s default.
  const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, 20_000);

    test("renders nothing when there are no transfers, then appears when one starts", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "vacation.mp4", method: "PUT", action: { kind: "stall", ms: 5000 } },
      ]);
      try {
        const { container } = render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await waitFor(() => expect(container.textContent).toBe(""));

        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);

        await screen.findByText("Uploading 1 item…");
        expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
      } finally {
        harness.dispose();
      }
    });

    test("ignores transfers belonging to other connections", async () => {
      const harnessA = await harnessWithConnection();
      const harnessB = await harnessWithConnection();
      try {
        // The widget is scoped to connection A; a real transfer started
        // through connection B's own services/engine must never appear.
        const { container } = render(
          <ServicesProvider value={harnessA.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        const file = await localFile(harnessB, "other.bin");
        await harnessB.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "other.bin", size: file.size },
        ]);
        await waitForEvent(
          harnessB,
          (e) => e.type === "transfer-updated" && e.transfer.state.kind === "uploaded",
        );

        expect(container.textContent).toBe("");
      } finally {
        harnessA.dispose();
        harnessB.dispose();
      }
    });

    test("does not resurface historical, already-uploaded transfers on load", async () => {
      // Regression: switching to a connection whose store already contains
      // finished uploads from a past session must not pop the widget open.
      const harness = await harnessWithConnection();
      try {
        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await waitForEvent(
          harness,
          (e) => e.type === "transfer-updated" && e.transfer.state.kind === "uploaded",
        );

        const { container } = render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await waitFor(() => expect(container.textContent).toBe(""));
      } finally {
        harness.dispose();
      }
    });

    test("title switches from 'Uploading…' to a completion summary once everything finishes", async () => {
      const harness = await harnessWithConnection();
      try {
        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await screen.findByText("Uploading 1 item…");
        await screen.findByText("1 upload complete", {}, { timeout: 15_000 });
      } finally {
        harness.dispose();
      }
    });

    test("title reports partial completion when some uploads failed", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "bad.bin", method: "PUT", action: { kind: "s3Error", status: 500, code: "InternalError", message: "boom" } },
      ]);
      try {
        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        const good = await localFile(harness, "good.bin");
        const bad = await localFile(harness, "bad.bin");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: good.path, name: "good.bin", size: good.size },
          { path: bad.path, name: "bad.bin", size: bad.size },
        ]);

        await screen.findByText("1 of 2 uploads complete", {}, { timeout: 15_000 });
      } finally {
        harness.dispose();
      }
    });

    test("collapsing hides the transfer list but keeps the title", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "vacation.mp4", method: "PUT", action: { kind: "stall", ms: 5000 } },
      ]);
      const user = userEvent.setup();
      try {
        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);

        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await screen.findByText("vacation.mp4");
        await user.click(screen.getByRole("button", { name: "Collapse transfers" }));

        expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
        expect(screen.getByText("Uploading 1 item…")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Expand transfers" }));
        expect(screen.getByText("vacation.mp4")).toBeInTheDocument();
      } finally {
        harness.dispose();
      }
    });

    test("failed transfers are sticky and dismissible", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "vacation.mp4", method: "PUT", action: { kind: "networkError" } },
      ]);
      const user = userEvent.setup();
      try {
        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await waitForEvent(
          harness,
          (e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed",
        );

        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await screen.findByText("0 of 1 uploads complete");
        // Failed count feeds the dock badge.
        await waitFor(() => expect(harness.record.badgeCounts).toContain(1));

        await user.click(screen.getByLabelText("Dismiss vacation.mp4"));
        // Widget disappears once its last transfer is dismissed — and the
        // dismissal is real: the transfer is gone from the engine's store.
        await waitFor(() =>
          expect(screen.queryByText("0 of 1 uploads complete")).not.toBeInTheDocument(),
        );
        expect(await harness.services.engine.listTransfers(CONN)).toEqual([]);
      } finally {
        harness.dispose();
      }
    });

    test("the close button clears everything and hides the widget", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "vacation.mp4", method: "PUT", action: { kind: "networkError" } },
      ]);
      const user = userEvent.setup();
      try {
        const file = await localFile(harness, "vacation.mp4");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await waitForEvent(
          harness,
          (e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed",
        );

        const { container } = render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await screen.findByText("0 of 1 uploads complete");
        await user.click(screen.getByRole("button", { name: "Close" }));

        await waitFor(() => expect(container.textContent).toBe(""));
        expect(await harness.services.engine.listTransfers(CONN)).toEqual([]);
      } finally {
        harness.dispose();
      }
    });

    test("never auto-dismisses, even long after every transfer succeeds", async () => {
      const harness = await harnessWithConnection();
      try {
        const file = await localFile(harness, "vacation.mp4");
        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await screen.findByText("1 upload complete", {}, { timeout: 15_000 });

        vi.useFakeTimers();
        try {
          // Advance well past the old 4s auto-dismiss timer (and its exit
          // animation) — the widget must still be there since it no longer
          // dismisses itself.
          act(() => {
            vi.advanceTimersByTime(60_000);
          });
        } finally {
          vi.useRealTimers();
        }

        expect(screen.getByText("1 upload complete")).toBeInTheDocument();
      } finally {
        harness.dispose();
      }
    });

    test("stays visible and does not auto-dismiss when a transfer fails", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "vacation.mp4", method: "PUT", action: { kind: "networkError" } },
      ]);
      try {
        const file = await localFile(harness, "vacation.mp4");
        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} />
          </ServicesProvider>,
        );

        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: file.path, name: "vacation.mp4", size: file.size },
        ]);
        await screen.findByText("0 of 1 uploads complete");

        vi.useFakeTimers();
        try {
          act(() => {
            vi.advanceTimersByTime(10_000);
          });
        } finally {
          vi.useRealTimers();
        }

        expect(screen.getByText("0 of 1 uploads complete")).toBeInTheDocument();
      } finally {
        harness.dispose();
      }
    });

    test("finished batches notify with a plain-language summary", async () => {
      const harness = await harnessWithConnection([
        { urlContains: "bad.bin", method: "PUT", action: { kind: "s3Error", status: 500, code: "InternalError", message: "boom" } },
      ]);
      const summaries: string[] = [];
      try {
        render(
          <ServicesProvider value={harness.services}>
            <TransferWidget connectionId={CONN} onBatchFinished={(s) => summaries.push(s)} />
          </ServicesProvider>,
        );

        const a = await localFile(harness, "a.bin");
        const b = await localFile(harness, "b.bin");
        const bad = await localFile(harness, "bad.bin");
        await harness.services.engine.enqueueFiles(CONN, "", [
          { path: a.path, name: "a.bin", size: a.size },
          { path: b.path, name: "b.bin", size: b.size },
          { path: bad.path, name: "bad.bin", size: bad.size },
        ]);

        await waitFor(() => expect(summaries).toEqual(["2 files uploaded, 1 file failed"]), {
          timeout: 15_000,
        });
        expect(harness.record.notifications).toContainEqual({
          title: "Lopload",
          body: "2 files uploaded, 1 file failed",
        });
      } finally {
        harness.dispose();
      }
    });
});
