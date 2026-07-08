// Glues the pure update-checking policy (src/lib/updatePolicy.ts) to the
// injected AppServices: checks on mount, re-checks at most every ~24h while
// the app stays open, and tracks whether any transfer (any connection) is
// currently in flight so the notice can reassure rather than block.
import { useEffect, useRef, useState } from "react";
import type { EngineEvent, TransferState } from "../lib/types";
import { buildUpdateNotice, shouldCheckForUpdate, UPDATE_CHECK_INTERVAL_MS, type UpdateNotice } from "../lib/updatePolicy";
import { useServices } from "./services";

const IN_FLIGHT_STATES: TransferState["kind"][] = ["queued", "sending", "checking"];

export interface AutoUpdateState {
  /** Null when there's nothing to show — no update found yet, or dismissed. */
  notice: UpdateNotice | null;
  installAndRelaunch(): void;
  dismiss(): void;
  /** Force-check for an update now, bypassing the periodic throttle.
   * Resolves with the version string if found, or null. */
  checkNow(): Promise<string | null>;
}

export function useAutoUpdate(): AutoUpdateState {
  const services = useServices();
  const [version, setVersion] = useState<string | null>(null);
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

  const notice = version && !dismissed ? buildUpdateNotice(hasTransfersInFlight) : null;

  return {
    notice,
    installAndRelaunch: () => void services.updates.installAndRelaunch(),
    dismiss: () => setDismissed(true),
    checkNow: async (): Promise<string | null> => {
      const found = await services.updates.checkForUpdate();
      if (found) {
        setVersion(found);
        setDismissed(false);
      }
      return found;
    },
  };
}
