// The context object and reader hook, split out of AutoUpdateContext.tsx so
// that file only exports the AutoUpdateProvider component — mixing a
// component export with a non-component export (the raw createContext()
// result) in one .tsx file breaks Fast Refresh boundaries.
import { createContext, useContext } from "react";
import type { AutoUpdateState } from "./useAutoUpdate";

export const AutoUpdateContext = createContext<AutoUpdateState | null>(null);

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
