import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  test("save is disabled until test-connection succeeds", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    render(
      <ServicesProvider value={services}>
        <SetupScreen onSaved={() => {}} />
      </ServicesProvider>,
    );

    await fillRequiredFields(user);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("It works.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  test("failed test-connection shows a plain-language message and keeps save disabled", async () => {
    const services = createFakeServices({
      testConnectionResult: { ok: false, message: "No internet connection." },
    });
    const user = userEvent.setup();
    render(
      <ServicesProvider value={services}>
        <SetupScreen onSaved={() => {}} />
      </ServicesProvider>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await screen.findByText("No internet connection.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
