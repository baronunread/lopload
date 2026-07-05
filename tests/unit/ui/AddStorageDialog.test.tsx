import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { AddStorageDialog } from "../../../src/ui/AddStorageDialog";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";

afterEach(cleanup);

describe("AddStorageDialog", () => {
  test("shows the form in a dialog with Cancel in the header, before the title", async () => {
    const services = createFakeServices({});
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <AddStorageDialog onSaved={() => {}} onClose={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );

    const dialog = await screen.findByRole("dialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const title = screen.getByText("Add a storage connection");
    // Top-left placement: Cancel precedes the title in the header row.
    expect(cancel.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog).toContainElement(screen.getByLabelText("Endpoint URL"));
  });

  test("Cancel closes the dialog", async () => {
    const services = createFakeServices({});
    const user = userEvent.setup();
    let closed = false;
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <AddStorageDialog onSaved={() => {}} onClose={() => (closed = true)} />
        </ServicesProvider>
      </Toasty>,
    );

    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(closed).toBe(true);
  });
});
