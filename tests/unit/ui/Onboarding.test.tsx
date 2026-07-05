import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { Onboarding } from "../../../src/ui/Onboarding";
import { ServicesProvider } from "../../../src/ui/services";
import { createFakeServices } from "./fakeServices";
import type { Connection } from "../../../src/lib/types";

afterEach(cleanup);

describe("Onboarding", () => {
  test("step 1 shows the form; saving moves to the celebration step; Start browsing hands off", async () => {
    const services = createFakeServices({
      testConnectionResult: { ok: true, message: "It works." },
    });
    const user = userEvent.setup();
    let done: Connection | null = null;

    render(
      <Toasty>
        <ServicesProvider value={services}>
          <Onboarding onDone={(conn) => (done = conn)} />
        </ServicesProvider>
      </Toasty>,
    );

    expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "Videos");
    await user.type(screen.getByLabelText("Endpoint URL"), "https://s3.example.test");
    await user.type(screen.getByLabelText("Access key"), "AKIA...");
    await user.type(screen.getByLabelText("Secret key"), "secret");
    await user.type(screen.getByLabelText("Storage name"), "videos-bucket");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await user.click(await screen.findByRole("button", { name: "Save connection" }));

    // Step 2: celebration, no form anymore.
    await screen.findByText("That's all!");
    expect(screen.getByText("Enjoy browsing and uploading.")).toBeInTheDocument();
    expect(done).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start browsing" }));
    expect(done).not.toBeNull();
    expect((done as unknown as Connection).name).toBe("Videos");
  });
});
