// Shares one useAutoUpdate() instance across the app so the top banner and
// the Settings "Check for updates now" button drive the same state: a manual
// check that finds a version surfaces the same banner the automatic check
// would, instead of the two running independent, disconnected checks.
import type { ReactNode } from "react";
import { useAutoUpdate } from "./useAutoUpdate";
import { AutoUpdateContext } from "./AutoUpdateContextValue";

export { useAutoUpdateContext } from "./AutoUpdateContextValue";

export function AutoUpdateProvider({ children }: { children: ReactNode }) {
  const state = useAutoUpdate();
  return <AutoUpdateContext.Provider value={state}>{children}</AutoUpdateContext.Provider>;
}
