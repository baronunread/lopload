import { afterEach, describe, expect, test, vi } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Confetti } from "../../../src/ui/Confetti";

afterEach(cleanup);

describe("Confetti", () => {
  test("renders into document.body via a portal, not the mounting subtree", () => {
    const { container } = render(
      <div data-testid="card">
        <Confetti />
      </div>,
    );

    // The overlay must not be a descendant of the card that mounted it —
    // otherwise it would be clipped by the card's bounds.
    const card = container.querySelector('[data-testid="card"]');
    expect(card?.querySelector(".fixed")).toBeNull();

    const overlay = document.body.querySelector(":scope > .fixed.inset-0");
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveAttribute("aria-hidden", "true");
  });

  test("unmounts itself once the burst animation finishes", () => {
    vi.useFakeTimers();
    try {
      render(<Confetti />);
      expect(document.body.querySelector(".fixed.inset-0")).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1400);
      });

      expect(document.body.querySelector(".fixed.inset-0")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
