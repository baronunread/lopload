import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";

import { AddStorageDialog } from "../../../src/ui/AddStorageDialog";
import { ServicesProvider } from "../../../src/ui/services";
import { createServiceHarness } from "../../support/serviceHarness";

afterEach(cleanup);

describe("AddStorageDialog", () => {
  test("shows the form in a dialog with a Close button in the header, after the title", async () => {
    const harness = await createServiceHarness();
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <AddStorageDialog onSaved={() => {}} onClose={() => {}} />
          </ServicesProvider>
        </Toasty>,
      );

      const dialog = await screen.findByRole("dialog");
      const close = screen.getByRole("button", { name: "Close" });
      const title = screen.getByText("Add a storage connection");
      expect(close.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      expect(dialog).toContainElement(screen.getByLabelText("Endpoint URL"));
    } finally {
      await harness.dispose();
    }
  });

  test("Close button closes the dialog", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    let closed = false;
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <AddStorageDialog onSaved={() => {}} onClose={() => (closed = true)} />
          </ServicesProvider>
        </Toasty>,
      );

      await user.click(await screen.findByRole("button", { name: "Close" }));
      expect(closed).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});
