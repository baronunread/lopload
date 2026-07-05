import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { SetupForm } from "../../../src/ui/SetupForm";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { TestConnectionResult } from "../../../src/ui/services";

afterEach(cleanup);

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Name"), "Videos");
  await user.type(screen.getByLabelText("Endpoint URL"), "https://s3.example.test");
  await user.type(screen.getByLabelText("Access key"), "AKIA...");
  await user.type(screen.getByLabelText("Secret key"), "secret");
  await user.type(screen.getByLabelText("Storage name"), "videos-bucket");
}

describe("SetupForm", () => {
  test("the single button starts as Test connection and becomes Save connection once the test passes", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupForm onSaved={() => {}} minTestDurationMs={0} />
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
          <SetupForm onSaved={() => {}} minTestDurationMs={0} />
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
          <SetupForm onSaved={() => {}} minTestDurationMs={0} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Save connection" });

    await user.type(screen.getByLabelText("Name"), "!");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
  });

  test("saving calls onSaved with the new connection", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    let saved: unknown = null;
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupForm onSaved={(conn) => (saved = conn)} minTestDurationMs={0} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await user.click(await screen.findByRole("button", { name: "Save connection" }));

    expect(saved).not.toBeNull();
    expect(services.savedConnections).toHaveLength(1);
  });

  test("a passed test-connection shows a success toast", async () => {
    const services = createFakeServices({ testConnectionResult: { ok: true, message: "It works." } });
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupForm onSaved={() => {}} minTestDurationMs={0} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    await screen.findByText("Connected");
    await screen.findByText("It works.");
  });

  test("the testing state is held for at least minTestDurationMs, even when the real test resolves instantly", async () => {
    let resolveTest: (result: TestConnectionResult) => void = () => {};
    const testPromise = new Promise<TestConnectionResult>((resolve) => {
      resolveTest = resolve;
    });
    const services = createFakeServices();
    services.keychain.testConnection = async (draft) => {
      services.testConnectionCalls.push(draft);
      return testPromise;
    };
    const user = userEvent.setup();
    render(
      <Toasty>
        <ServicesProvider value={services}>
          <SetupForm onSaved={() => {}} minTestDurationMs={80} />
        </ServicesProvider>
      </Toasty>,
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    // The real test resolves right away...
    resolveTest({ ok: true, message: "It works." });
    // ...but the button must still be in its pre-result ("Test connection",
    // loading) state shortly after, because the minimum-duration floor
    // hasn't elapsed yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();

    // Once the floor elapses, it flips to Save connection.
    await screen.findByRole("button", { name: "Save connection" }, { timeout: 1000 });
  });
});
