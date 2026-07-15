import "../../support/noActEnv";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";

import { Onboarding } from "../../../src/ui/Onboarding";
import { ServicesProvider } from "../../../src/ui/services";
import { createServiceHarness } from "../../support/serviceHarness";
import type { Connection } from "../../../src/lib/types";

afterEach(cleanup);

describe("Onboarding", () => {
  test("step 1 shows the form; saving moves to the celebration step; Start browsing hands off", async () => {
    const harness = await createServiceHarness();
    const user = userEvent.setup();
    let done: Connection | null = null;

    try {
      render(
        <Toasty>
          <ServicesProvider value={harness.services}>
            <Onboarding onDone={(conn) => (done = conn)} />
          </ServicesProvider>
        </Toasty>,
      );

      expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument();

      // Real endpoint/credentials — "Test connection" makes a genuine round
      // trip to the fresh bucket the harness just created.
      await user.type(screen.getByLabelText("Name"), "Videos");
      await user.type(screen.getByLabelText("Endpoint URL"), harness.bucketConnection.endpoint);
      await user.type(screen.getByLabelText("Access key"), harness.credentials.accessKey);
      await user.type(screen.getByLabelText("Secret key"), harness.credentials.secretKey);
      await user.type(screen.getByLabelText("Bucket name"), harness.bucketConnection.bucket);
      await user.click(screen.getByRole("button", { name: "Test connection" }));
      await user.click(await screen.findByRole("button", { name: "Save connection" }));

      // Step 2: celebration, no form anymore.
      await screen.findByText("That's all!");
      expect(screen.getByText("Enjoy browsing and uploading.")).toBeInTheDocument();
      expect(done).toBeNull();

      await user.click(screen.getByRole("button", { name: "Start browsing" }));
      expect(done).not.toBeNull();
      expect((done as unknown as Connection).name).toBe("Videos");
    } finally {
      await harness.dispose();
    }
  });
});
