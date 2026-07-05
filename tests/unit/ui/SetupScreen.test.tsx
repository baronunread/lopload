import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { SetupScreen } from "../../../src/ui/SetupScreen";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";

afterEach(cleanup);

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Videos");
  await user.type(screen.getByLabelText("Endpoint URL"), "https://s3.example.test");
  await user.type(screen.getByLabelText("Access key"), "AKIA...");
  await user.type(screen.getByLabelText("Secret key"), "secret");
  await user.type(screen.getByLabelText("Storage name"), "videos-bucket");
}

describe("SetupScreen", () => {
  test("the single button starts as Test connection and becomes Save connection once the test passes", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupScreen onSaved={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Test connection" }));

    const saveButton = await screen.findByRole("button", { name: "Save connection" });
    expect(saveButton).toBeEnabled();
  });

  test("a failed test-connection shows an error toast, shakes the button, and never reveals Save", async () => {
    const services = createFakeServices({
      testConnectionResult: { ok: false, message: "No internet connection." },
    });
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupScreen onSaved={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    const button = screen.getByRole("button", { name: "Test connection" });
    await user.click(button);

    await screen.findByText("No internet connection.");
    await screen.findByText("Couldn't connect");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();
  });

  test("editing a field after a passed test resets back to Test connection", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupScreen onSaved={() => {}} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Save connection" });

    await user.type(screen.getByLabelText("Name"), "!");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
  });
});
