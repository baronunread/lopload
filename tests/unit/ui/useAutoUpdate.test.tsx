import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFile } from "node:fs/promises";

import { ServicesProvider } from "../../../src/ui/services";
import { useAutoUpdate } from "../../../src/ui/useAutoUpdate";
import { faultyFetch } from "../../support/faultyFetch";
import { createServiceHarness, type ServiceHarness } from "../../support/serviceHarness";

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

/** Saves a connection so a real upload can be started against it. */
async function saveConnection(harness: ServiceHarness, id = "conn-1"): Promise<void> {
  await harness.services.connections.save(
    {
      id,
      name: "Test",
      endpoint: harness.bucketConnection.endpoint,
      bucket: harness.bucketConnection.bucket,
      region: harness.bucketConnection.region,
      lastPrefix: "",
      createdAt: Date.now(),
    },
    harness.credentials,
  );
}

/** Renders an update with version 9.9.9, clicks Update, then waits for phase to become "ready". */
async function advanceToReady(harness: ServiceHarness) {
  render(
    <ServicesProvider value={harness.services}>
      <Harness />
    </ServicesProvider>,
  );
  const update = await screen.findByRole("button", { name: "Update" });
  await userEvent.click(update);
  // downloading → ready (Node host's downloadUpdate resolves instantly)
  await screen.findByText("Restart to finish updating.");
}

describe("useAutoUpdate", () => {
  test("shows nothing when checkForUpdate finds nothing new", async () => {
    const harness = await createServiceHarness();
    try {
      render(
        <ServicesProvider value={harness.services}>
          <Harness />
        </ServicesProvider>,
      );
      await screen.findByText("no banner");
    } finally {
      await harness.dispose();
    }
  });

  test("shows the plain restart notice when no transfers are in flight", async () => {
    const harness = await createServiceHarness();
    harness.control.availableUpdate = "9.9.9";
    try {
      await advanceToReady(harness);
    } finally {
      await harness.dispose();
    }
  });

  test("warns about in-flight transfers being interrupted instead of hiding the restart action", async () => {
    const harness = await createServiceHarness({
      wrapFetch: (inner) =>
        faultyFetch(inner, [{ urlContains: "stall.bin", method: "PUT", action: { kind: "stall", ms: 3000 } }]),
    });
    harness.control.availableUpdate = "9.9.9";
    try {
      await saveConnection(harness);
      const path = `${harness.workdir}/stall.bin`;
      await writeFile(path, new Uint8Array([1, 2, 3, 4]));

      await advanceToReady(harness);

      // A real upload, held in "sending" by the stall fault.
      await harness.services.engine.enqueueFiles("conn-1", "", [
        { path, name: "stall.bin", size: 4 },
      ]);

      const button = await screen.findByRole("button", { name: "Restart now" });
      expect(screen.getByText((text) => text.includes("will interrupt your transfers"))).toBeInTheDocument();
      expect(button).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("relaunchApp is called when restart button is clicked", async () => {
    const harness = await createServiceHarness();
    harness.control.availableUpdate = "9.9.9";
    try {
      await advanceToReady(harness);

      const restart = await screen.findByRole("button", { name: "Restart now" });
      await userEvent.click(restart);
      await waitFor(() => expect(harness.record.installAndRelaunchCalls.length).toBe(1));

      const dismiss = screen.getByRole("button", { name: "Dismiss" });
      await userEvent.click(dismiss);
      await screen.findByText("no banner");
    } finally {
      await harness.dispose();
    }
  });
});
