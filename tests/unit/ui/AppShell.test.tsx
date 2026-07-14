import "../../support/noActEnv";

import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeFile } from "node:fs/promises";

import { AppShell } from "../../../src/ui/AppShell";
import { ServicesProvider } from "../../../src/ui/services";
import { createRealServices, type RealServicesHandle } from "../../../src/services/real";
import { bucketProbe } from "../../support/bucketProbe";
import { faultyFetch, type Fault } from "../../support/faultyFetch";
import { freshBucket } from "../../support/minio";
import { createNodeHost } from "../../support/nodeHost";

afterEach(cleanup);

// Real MinIO round trips take longer than bun's 5s default.
const test = (name: string, fn: () => Promise<void>) => bunTest(name, fn, 20_000);

interface TwoConnections {
  services: RealServicesHandle;
  workdir: string;
  dispose(): void;
}

/** Two real, isolated connections — "videos" and "documents" — each backed
 * by its own fresh bucket, sharing one Host/RealServices instance (as the
 * app does). Seeds the content and transfers each AppShell test needs. */
async function twoConnections(): Promise<TwoConnections> {
  const bucketA = await freshBucket(); // videos
  const bucketB = await freshBucket(); // documents

  const faults: Fault[] = [
    // "Videos" has an upload permanently mid-flight.
    { urlContains: "vacation.mp4", method: "PUT", action: { kind: "stall", ms: 60_000 } },
    // "Documents" has an upload that fails outright.
    { urlContains: "invoice.pdf", method: "PUT", action: { kind: "networkError" } },
  ];
  const { host, workdir } = await createNodeHost();
  host.fetch = faultyFetch(host.fetch, faults);
  const services = createRealServices(host);

  await services.connections.save(
    {
      id: "videos",
      name: "Videos",
      endpoint: bucketA.connection.endpoint,
      bucket: bucketA.name,
      region: bucketA.connection.region,
      lastPrefix: "clips/",
      createdAt: 0,
    },
    bucketA.credentials,
  );
  await services.connections.save(
    {
      id: "documents",
      name: "Documents",
      endpoint: bucketB.connection.endpoint,
      bucket: bucketB.name,
      region: bucketB.connection.region,
      lastPrefix: "",
      createdAt: 1,
    },
    bucketB.credentials,
  );

  await bucketProbe(bucketA.client, bucketA.name).put("clips/vacation.mp4", "video");
  await bucketProbe(bucketB.client, bucketB.name).put("invoice.pdf", "invoice");

  return {
    services,
    workdir,
    dispose() {
      services.dispose();
    },
  };
}

/** Starts a real (permanently stalled) upload for "videos", and a real
 * (failing) one for "documents" — both settle into the states the AppShell
 * tests need before the widget or browser observes them. */
async function seedTransfers(setup: TwoConnections): Promise<void> {
  const vacation = `${setup.workdir}/vacation.mp4`;
  await writeFile(vacation, "video");
  await setup.services.engine.enqueueFiles("videos", "clips/", [
    { path: vacation, name: "vacation.mp4", size: 5 },
  ]);

  const invoice = `${setup.workdir}/invoice.pdf`;
  await writeFile(invoice, "invoice");
  await setup.services.engine.enqueueFiles("documents", "", [
    { path: invoice, name: "invoice.pdf", size: 7 },
  ]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("documents transfer never failed")), 15_000);
    const unsub = setup.services.engine.subscribe((event) => {
      if (
        event.type === "transfer-updated" &&
        event.transfer.connectionId === "documents" &&
        event.transfer.state.kind === "failed"
      ) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

describe("AppShell first run", () => {
  test("zero connections shows the onboarding with the connection form", async () => {
    const { host } = await createNodeHost();
    const services = createRealServices(host);
    try {
      render(
        <ServicesProvider value={services}>
          <AppShell />
        </ServicesProvider>,
      );

      await waitFor(() => expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument());
      expect(screen.getByLabelText("Endpoint URL")).toBeInTheDocument();
      expect(screen.getByLabelText("Access key")).toBeInTheDocument();
    } finally {
      services.dispose();
    }
  });
});

describe("AppShell connection switcher", () => {
  test("switching connections resets the browser to that connection's lastPrefix and isolates transfers", async () => {
    const setup = await twoConnections();
    try {
      await seedTransfers(setup);

      render(
        <ServicesProvider value={setup.services}>
          <AppShell />
        </ServicesProvider>,
      );

      // Starts on the first connection (Videos), at its remembered folder.
      // The file name appears twice — once in the browser table, once in the
      // transfer list — so we use getAllByText throughout this test.
      await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByText("Uploading")).toBeInTheDocument());
      expect(screen.queryByText("invoice.pdf")).not.toBeInTheDocument();
      expect(screen.queryByText("Couldn't send")).not.toBeInTheDocument();

      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Storage connection"));
      await user.click(screen.getByRole("option", { name: "Documents" }));

      // Now shows Documents' own folder and transfers — no state mixing.
      await waitFor(() => expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0));
      await waitFor(() => expect(screen.getByText("Couldn't send")).toBeInTheDocument());
      expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
      expect(screen.queryByText("Uploading")).not.toBeInTheDocument();
    } finally {
      setup.dispose();
    }
  });
});

describe("AppShell manage connections", () => {
  test("removing the active connection falls back to another remaining one", async () => {
    const setup = await twoConnections();
    try {
      render(
        <ServicesProvider value={setup.services}>
          <AppShell />
        </ServicesProvider>,
      );

      await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));

      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Storage connection"));
      await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

      await screen.findByText("Storage connections");
      await user.click(screen.getByRole("button", { name: "Remove Videos" }));
      await user.click(await screen.findByRole("button", { name: "Remove" }));

      // Falls back to the only remaining connection, Documents, with no
      // leftover trace of Videos' state.
      await waitFor(() => expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0));
      expect(screen.queryByText("vacation.mp4")).not.toBeInTheDocument();
      const remaining = await setup.services.connections.list();
      expect(remaining.map((c) => c.id)).toEqual(["documents"]);
    } finally {
      setup.dispose();
    }
  });

  test("deleting the active connection never resurrects the fallback connection's old, already-uploaded transfers", async () => {
    // Regression: deleting a connection switches `currentId` to the
    // fallback connection just like an explicit switch does. If the
    // fallback happens to have a finished upload sitting in its history,
    // the floating widget must not pop up out of nowhere for it — the
    // widget should only ever appear for uploads enqueued while it's
    // mounted, not historical completed ones surfaced by a connection
    // change.
    const setup = await twoConnections();
    try {
      // Give Documents a real, already-*completed* upload (no fault on this
      // key) instead of the failing one seedTransfers() would set up.
      const receipt = `${setup.workdir}/receipt.pdf`;
      await writeFile(receipt, "receipt");
      await setup.services.engine.enqueueFiles("documents", "", [
        { path: receipt, name: "receipt.pdf", size: 7 },
      ]);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("never uploaded")), 15_000);
        const unsub = setup.services.engine.subscribe((event) => {
          if (
            event.type === "transfer-updated" &&
            event.transfer.connectionId === "documents" &&
            event.transfer.state.kind === "uploaded"
          ) {
            clearTimeout(timer);
            unsub();
            resolve();
          }
        });
      });

      render(
        <ServicesProvider value={setup.services}>
          <AppShell />
        </ServicesProvider>,
      );

      await waitFor(() => expect(screen.getAllByText("vacation.mp4").length).toBeGreaterThan(0));

      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Storage connection"));
      await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

      await screen.findByText("Storage connections");
      await user.click(screen.getByRole("button", { name: "Remove Videos" }));
      await user.click(await screen.findByRole("button", { name: "Remove" }));

      await waitFor(() => expect(screen.getAllByText("invoice.pdf").length).toBeGreaterThan(0));
      expect(screen.queryByText(/Uploading \d+ item/)).not.toBeInTheDocument();
      expect(screen.queryByText(/uploads? complete/)).not.toBeInTheDocument();
    } finally {
      setup.dispose();
    }
  });

  test("removing the last connection returns to the onboarding", async () => {
    const bucket = await freshBucket();
    const { host } = await createNodeHost();
    const services = createRealServices(host);
    try {
      await services.connections.save(
        {
          id: "videos",
          name: "Videos",
          endpoint: bucket.connection.endpoint,
          bucket: bucket.name,
          region: bucket.connection.region,
          lastPrefix: "",
          createdAt: 0,
        },
        bucket.credentials,
      );

      render(
        <ServicesProvider value={services}>
          <AppShell />
        </ServicesProvider>,
      );

      const user = userEvent.setup();
      await screen.findByLabelText("Storage connection");
      await user.click(screen.getByLabelText("Storage connection"));
      await user.click(screen.getByRole("option", { name: "Manage storage connections…" }));

      await screen.findByText("Storage connections");
      await user.click(screen.getByRole("button", { name: "Remove Videos" }));
      await user.click(await screen.findByRole("button", { name: "Remove" }));

      await waitFor(() => expect(screen.getByText("Welcome to Lopload")).toBeInTheDocument());
    } finally {
      services.dispose();
    }
  });
});
