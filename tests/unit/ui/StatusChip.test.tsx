import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusChip } from "../../../src/ui/StatusChip";
import type { TransferState } from "../../../src/lib/types";

afterEach(cleanup);

describe("StatusChip", () => {
  test("renders the exact five spec labels with data-state attributes", () => {
    const cases: Array<{ state: TransferState; label: string; dataState: string }> = [
      { state: { kind: "queued" }, label: "Queued", dataState: "queued" },
      {
        state: { kind: "sending", percent: 42 },
        label: "Sending — 42%",
        dataState: "sending",
      },
      { state: { kind: "checking" }, label: "Checking", dataState: "checking" },
      { state: { kind: "uploaded" }, label: "Uploaded ✓", dataState: "uploaded" },
      {
        state: { kind: "failed", errorClass: "offline" },
        label: "Couldn't send — tap to retry",
        dataState: "failed",
      },
    ];

    for (const { state, label, dataState } of cases) {
      const { container, unmount } = render(<StatusChip state={state} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(container.querySelector(`[data-state="${dataState}"]`)).not.toBeNull();
      unmount();
    }
  });

  test("failed chip is clickable and calls onRetry", async () => {
    const user = userEvent.setup();
    let retried = false;
    render(
      <StatusChip
        state={{ kind: "failed", errorClass: "credentials" }}
        onRetry={() => {
          retried = true;
        }}
      />,
    );
    await user.click(screen.getByText("Couldn't send — tap to retry"));
    expect(retried).toBe(true);
  });
});
