// Shares one useAutoUpdate() instance across the app so the top banner and
// the Settings "Check for updates now" button drive the same state: a manual
// check that finds a version surfaces the same banner the automatic check
// would, instead of the two running independent, disconnected checks.
import { createContext, useContext, type ReactNode } from "react";
import { useAutoUpdate, type AutoUpdateState } from "./useAutoUpdate";

const AutoUpdateContext = createContext<AutoUpdateState | null>(null);

export function AutoUpdateProvider({ children }: { children: ReactNode }) {
  const state = useAutoUpdate();
  return <AutoUpdateContext.Provider value={state}>{children}</AutoUpdateContext.Provider>;
}

/** Reads the shared auto-update state. Throws if used outside an
 * AutoUpdateProvider. */
export function useAutoUpdateContext(): AutoUpdateState {
  const ctx = useContext(AutoUpdateContext);
  if (!ctx) {
    throw new Error(
      "useAutoUpdateContext() called without an AutoUpdateProvider — wrap the app in <AutoUpdateProvider>",
    );
  }
  return ctx;
}
