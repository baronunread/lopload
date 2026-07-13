import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TransferWidget } from "../../../src/ui/TransferWidget";
import { MoveProgressProvider } from "../../../src/ui/browser/MoveProgressContext";
import { ServicesProvider } from "../../../src/ui/services";
import type { MoveProgress } from "../../../src/ui/services";
import { createFakeServices, type FakeServices } from "./fakeServices";

afterEach(cleanup);

const GB = 1024 * 1024 * 1024;

function makeMove(overrides: Partial<MoveProgress> = {}): MoveProgress {
  return {
    moveId: "m1",
    connectionId: "conn-1",
    fromKey: "Videos/Clips/",
    toKey: "Archive/Clips/",
    copiedBytes: 0,
    totalBytes: 13 * GB,
    copiedItems: 0,
    totalItems: 13,
    status: "moving",
    ...overrides,
  };
}

function renderWidget(services: FakeServices) {
  return render(
    <ServicesProvider value={services}>
      <MoveProgressProvider>
        <TransferWidget connectionId="conn-1" />
      </MoveProgressProvider>
    </ServicesProvider>,
  );
}

/** Progress events are coalesced onto an animation frame, so a flushed emit
 * has to let one pass before the row reflects it. */
async function emitMove(services: FakeServices, move: MoveProgress) {
  act(() => {
    services.emitMove(move);
  });
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe("move progress in the transfer widget", () => {
  test("counts only the moves still running in the title, not the ones already done", async () => {
    const services = createFakeServices({ connections: [] });
    renderWidget(services);

    await emitMove(services, makeMove({ moveId: "m1", status: "completed", copiedItems: 13 }));
    await emitMove(services, makeMove({ moveId: "m2", status: "completed", copiedItems: 13 }));
    await emitMove(services, makeMove({ moveId: "m3", copiedBytes: 6 * GB, copiedItems: 1 }));

    // Two finished rows are still listed, but only one move is actually moving.
    await screen.findByText("Moving 1 item…");
    expect(screen.queryByText("Moving 3 items…")).not.toBeInTheDocument();
    expect(screen.getAllByText("13 items moved")).toHaveLength(2);
  });

  test("summarizes once every move has landed", async () => {
    const services = createFakeServices({ connections: [] });
    renderWidget(services);

    await emitMove(services, makeMove({ moveId: "m1", copiedBytes: 1 * GB }));
    await screen.findByText("Moving 1 item…");

    await emitMove(
      services,
      makeMove({ moveId: "m1", status: "completed", copiedBytes: 13 * GB, copiedItems: 13 }),
    );
    await screen.findByText("1 item moved");
  });

  test("leads with bytes so the detail line can't contradict the bar", async () => {
    const services = createFakeServices({ connections: [] });
    renderWidget(services);

    // Mid-move: several big objects are part-copied, so bytes are well along
    // while barely any object has actually finished. The row must not pair a
    // 57% bar with a "1 of 13 items" that reads as stuck.
    await emitMove(services, makeMove({ copiedBytes: 7 * GB, copiedItems: 1 }));

    await waitFor(() => expect(screen.getByText(/13 items/)).toBeInTheDocument());
    expect(screen.getByText(/7 GB of 13 GB · 13 items/)).toBeInTheDocument();
    expect(screen.queryByText(/1 of 13 items/)).not.toBeInTheDocument();
    expect(screen.getByText("Moving 53%")).toBeInTheDocument();
  });

  test("falls back to an item count for a folder with no bytes in it", async () => {
    const services = createFakeServices({ connections: [] });
    renderWidget(services);

    await emitMove(services, makeMove({ totalBytes: 0, copiedBytes: 0, copiedItems: 2, totalItems: 4 }));

    await screen.findByText("2 of 4 items");
    expect(screen.getByText("Moving 50%")).toBeInTheDocument();
  });

  test("holds short of 100% until the move actually reports completion", async () => {
    const services = createFakeServices({ connections: [] });
    renderWidget(services);

    // Every byte copied, but the originals still have to be deleted — a full
    // bar on a row that's still working would be a lie.
    await emitMove(services, makeMove({ copiedBytes: 13 * GB, copiedItems: 13 }));

    await screen.findByText("Moving 99%");
  });
});
