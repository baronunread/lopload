import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { AddStorageDialog } from "../../../src/ui/AddStorageDialog";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";

afterEach(cleanup);

describe("AddStorageDialog", () => {
  test("shows the form in a dialog with a Close button in the header, after the title", async () => {
    const services = createFakeServices({});
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <AddStorageDialog onSaved={() => {}} onClose={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );

    const dialog = await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    const title = screen.getByText("Add a storage connection");
    expect(close.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(dialog).toContainElement(screen.getByLabelText("Endpoint URL"));
  });

  test("Close button closes the dialog", async () => {
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

    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(closed).toBe(true);
  });
});
