import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";

import { SetupForm } from "../../../src/ui/SetupForm";
import { ServicesProvider } from "../../../src/ui/services";
import { createServiceHarness, type ServiceHarness } from "../../support/serviceHarness";

afterEach(cleanup);

async function fillRequiredFields(
  user: ReturnType<typeof userEvent.setup>,
  harness: ServiceHarness,
  overrides: { endpoint?: string; bucket?: string } = {},
) {
  await user.type(screen.getByLabelText("Name"), "Videos");
  await user.type(
    screen.getByLabelText("Endpoint URL"),
    overrides.endpoint ?? harness.bucketConnection.endpoint,
  );
  await user.type(screen.getByLabelText("Access key"), harness.credentials.accessKey);
  await user.type(screen.getByLabelText("Secret key"), harness.credentials.secretKey);
  await user.type(screen.getByLabelText("Bucket name"), overrides.bucket ?? harness.bucketConnection.bucket);
}

describe("SetupForm", () => {
  test("the single button starts as Test connection and becomes Save connection once the test passes", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <SetupForm onSaved={() => {}} minTestDurationMs={0} />
          </ServicesProvider>
        </Toasty>,
      );

      await fillRequiredFields(user, harness);
      expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();

      // A real round trip against the fresh bucket the harness just made.
      await user.click(screen.getByRole("button", { name: "Test connection" }));

      const saveButton = await screen.findByRole("button", { name: "Save connection" });
      expect(saveButton).toBeEnabled();
    } finally {
      await harness.dispose();
    }
  });

  test(
    "a failed test-connection shows an error toast, shakes the button, and never reveals Save",
    async () => {
      const harness = await createServiceHarness();
      const user = userEvent.setup();
      try {
        render(
          <Toasty>
            <ServicesProvider value={harness.services}>
              <SetupForm onSaved={() => {}} minTestDurationMs={0} />
            </ServicesProvider>
          </Toasty>,
        );

        // A port nobody is listening on — a genuine connection refusal. Under
        // bun's native fetch this surfaces as a plain Error (not a TypeError
        // with "failed to fetch" wording), which classifyError() can't place
        // more specifically than "unknown" — a real, if unglamorous, edge
        // case of running the Node host rather than the browser/webview one.
        await fillRequiredFields(user, harness, { endpoint: "http://127.0.0.1:1" });
        const button = screen.getByRole("button", { name: "Test connection" });
        await user.click(button);

        // The AWS SDK retries a network failure a few times with backoff
        // before giving up, so this can take a bit longer than the default
        // findByText timeout.
        await screen.findByText(
          "Something went wrong - please try again.",
          {},
          { timeout: 10_000 },
        );
        await screen.findByText("Couldn't connect");
        expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();
      } finally {
        await harness.dispose();
      }
    },
    15_000,
  );

  test("editing a field after a passed test resets back to Test connection", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <SetupForm onSaved={() => {}} minTestDurationMs={0} />
          </ServicesProvider>
        </Toasty>,
      );

      await fillRequiredFields(user, harness);
      await user.click(screen.getByRole("button", { name: "Test connection" }));
      await screen.findByRole("button", { name: "Save connection" });

      await user.type(screen.getByLabelText("Name"), "!");
      expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument();
    } finally {
      await harness.dispose();
    }
  });

  test("saving calls onSaved with the new connection", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    let saved: unknown = null;
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <SetupForm onSaved={(conn) => (saved = conn)} minTestDurationMs={0} />
          </ServicesProvider>
        </Toasty>,
      );

      await fillRequiredFields(user, harness);
      await user.click(screen.getByRole("button", { name: "Test connection" }));
      await user.click(await screen.findByRole("button", { name: "Save connection" }));

      expect(saved).not.toBeNull();
      // Saved for real: it's in the connection store, not just a callback arg.
      const list = await harness.services.connections.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("Videos");
    } finally {
      await harness.dispose();
    }
  });

  test("a passed test-connection shows a success toast", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <SetupForm onSaved={() => {}} minTestDurationMs={0} />
          </ServicesProvider>
        </Toasty>,
      );

      await fillRequiredFields(user, harness);
      await user.click(screen.getByRole("button", { name: "Test connection" }));

      await screen.findByText("Connected");
      await screen.findByText("Connection works.");
    } finally {
      await harness.dispose();
    }
  });

  test("the testing state is held for at least minTestDurationMs, even when the real test resolves instantly", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <SetupForm onSaved={() => {}} minTestDurationMs={200} />
          </ServicesProvider>
        </Toasty>,
      );

      await fillRequiredFields(user, harness);
      await user.click(screen.getByRole("button", { name: "Test connection" }));

      // The real test against local MinIO resolves in a handful of
      // milliseconds — but the button must still be in its pre-result
      // ("Test connection", loading) state shortly after, because the
      // minimum-duration floor hasn't elapsed yet.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(screen.getByRole("button", { name: /test connection/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();

      // Once the floor elapses, it flips to Save connection.
      await screen.findByRole("button", { name: "Save connection" }, { timeout: 1000 });
    } finally {
      await harness.dispose();
    }
  });
});
