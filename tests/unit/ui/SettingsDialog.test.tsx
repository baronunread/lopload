import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SettingsDialog } from "../../../src/ui/SettingsDialog";
import { ServicesProvider } from "../../../src/ui/services";
import { AutoUpdateProvider } from "../../../src/ui/AutoUpdateContext";
import { createServiceHarness } from "../../support/serviceHarness";

afterEach(cleanup);

function renderDialog(harness: Awaited<ReturnType<typeof createServiceHarness>>, connectionId: string | null) {
  return render(
    <ServicesProvider value={harness.services}>
      <AutoUpdateProvider>
        <SettingsDialog onClose={() => {}} connectionId={connectionId} />
      </AutoUpdateProvider>
    </ServicesProvider>,
  );
}

describe("SettingsDialog", () => {
  test("opens on General and shows the download directory action", async () => {
    const harness = await createServiceHarness();
    try {
      renderDialog(harness, null);
      await screen.findByRole("dialog");
      expect(
        screen.getByRole("button", { name: "General" }).getAttribute("aria-current"),
      ).toBe("true");
      expect(screen.getByText("Default download directory")).toBeTruthy();
    } finally {
      await harness.dispose();
    }
  });

  test("switching categories shows the right pane", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      renderDialog(harness, null);
      await screen.findByRole("dialog");

      await user.click(screen.getByRole("button", { name: "Transfers" }));
      expect(screen.getByText("Transfer speed")).toBeTruthy();
      expect(screen.getByLabelText("Concurrent files")).toBeTruthy();
      expect(screen.queryByText("Default download directory")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Updates" }));
      expect(screen.getByRole("button", { name: "Check for updates now" })).toBeTruthy();
      expect(screen.queryByText("Transfer speed")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Maintenance" }));
      expect(
        screen.getByText("Removes abandoned multipart upload fragments that still count against storage."),
      ).toBeTruthy();
    } finally {
      await harness.dispose();
    }
  });

  test("Maintenance cleanup action is disabled with a hint when no connection is active", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      renderDialog(harness, null);
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Maintenance" }));

      const cleanupButton = screen.getByRole("button", { name: "Clean up interrupted uploads" });
      expect(cleanupButton.hasAttribute("disabled")).toBe(true);
      expect(screen.getByText("Connect to a storage to run cleanup.")).toBeTruthy();
    } finally {
      await harness.dispose();
    }
  });

  test("Maintenance cleanup action is enabled when a connection is active", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      renderDialog(harness, "conn-1");
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Maintenance" }));

      const cleanupButton = screen.getByRole("button", { name: "Clean up interrupted uploads" });
      expect(cleanupButton.hasAttribute("disabled")).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  test("changing a knob in Transfers persists via the settings service", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      renderDialog(harness, null);
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Transfers" }));

      await user.click(screen.getByRole("combobox", { name: "Concurrent files" }));
      await user.click(await screen.findByRole("option", { name: "7" }));

      await waitFor(async () => {
        const tuning = await harness.services.settings.getTransferTuning();
        expect(tuning.concurrentFiles).toBe(7);
        expect(tuning.preset).toBe("custom");
      });
    } finally {
      await harness.dispose();
    }
  });
});
