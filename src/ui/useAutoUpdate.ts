// Glues the pure update-checking policy (src/lib/updatePolicy.ts) to the
// injected AppServices: checks on mount, re-checks at most every ~24h while
// the app stays open, and drives the two-click flow: found → download (with
// progress) → restart. Tracks whether any transfer is currently in flight so
// the "ready to restart" copy can warn rather than surprise.
import { useEffect, useRef, useState } from "react";
import type { EngineEvent, TransferState } from "../lib/types";
import {
  buildUpdateBanner,
  shouldCheckForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateBanner,
  type UpdatePhase,
} from "../lib/updatePolicy";
import { useServices } from "./services";

const IN_FLIGHT_STATES: TransferState["kind"][] = ["queued", "sending", "checking"];

export interface AutoUpdateState {
  /** Null when there's nothing to show: no update found yet, or dismissed. */
  banner: UpdateBanner | null;
  /** Where the found update is in the flow; meaningful only when banner != null. */
  phase: UpdatePhase;
  /** Download progress 0–100; meaningful only while phase === "downloading". */
  percent: number;
  /** Begin downloading + staging the found update (available → downloading → ready). */
  startDownload(): void;
  /** Relaunch into the staged update (only valid once phase === "ready"). */
  relaunch(): void;
  dismiss(): void;
  /** Force-check for an update now, bypassing the periodic throttle.
   * Resolves with the version string if found, or null. */
  checkNow(): Promise<string | null>;
}

export function useAutoUpdate(): AutoUpdateState {
  const services = useServices();
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [hasTransfersInFlight, setHasTransfersInFlight] = useState(false);
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(true);
  const inFlightIds = useRef(new Set<string>());
  const lastCheckedAt = useRef<number | null>(null);

  useEffect(() => {
    void services.updates.isAutoUpdateEnabled().then(setAutoUpdateEnabled);
  }, [services]);

  useEffect(() => {
    return services.engine.subscribe((event: EngineEvent) => {
      if (event.type !== "transfer-updated") return;
      if (IN_FLIGHT_STATES.includes(event.transfer.state.kind)) {
        inFlightIds.current.add(event.transfer.id);
      } else {
        inFlightIds.current.delete(event.transfer.id);
      }
      setHasTransfersInFlight(inFlightIds.current.size > 0);
    });
  }, [services]);

  useEffect(() => {
    let cancelled = false;

    async function runCheck() {
      if (!autoUpdateEnabled) return;
      const now = Date.now();
      if (!shouldCheckForUpdate(now, lastCheckedAt.current)) return;
      lastCheckedAt.current = now;
      const found = await services.updates.checkForUpdate();
      if (!cancelled && found) setVersion(found);
    }

    void runCheck();
    const interval = setInterval(() => void runCheck(), UPDATE_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [services, autoUpdateEnabled]);

  function startDownload() {
    if (phase !== "available") return;
    setPhase("downloading");
    setPercent(0);
    services.updates
      .downloadUpdate((p) => setPercent(p))
      .then(() => setPhase("ready"))
      .catch(() => {
        // Let the user retry from "available" rather than stranding the banner
        // on a frozen progress bar.
        setPhase("available");
        setPercent(0);
      });
  }

  const banner =
    version && !dismissed
      ? buildUpdateBanner(phase, version, hasTransfersInFlight, percent)
      : null;

  return {
    banner,
    phase,
    percent,
    startDownload,
    relaunch: () => void services.updates.relaunchApp(),
    dismiss: () => setDismissed(true),
    checkNow: async (): Promise<string | null> => {
      const found = await services.updates.checkForUpdate();
      if (found) {
        setVersion(found);
        setPhase("available");
        setPercent(0);
        setDismissed(false);
      }
      return found;
    },
  };
}
