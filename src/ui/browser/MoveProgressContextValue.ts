// The context object, its shape, and the reader hook, split out of
// MoveProgressContext.tsx so that file only exports the
// MoveProgressProvider component — mixing a component export with
// non-component exports (the raw createContext() result, the interface) in
// one .tsx file breaks Fast Refresh boundaries.
import { createContext, useContext } from "react";
import type { MoveProgress } from "../services";

export interface MoveProgressCtx {
  moves: MoveProgress[];
  dismissMove: (moveId: string) => void;
  clearCompleted: () => void;
}

export const MoveProgressContext = createContext<MoveProgressCtx | null>(null);

export function useMoveProgress(): MoveProgressCtx {
  const ctx = useContext(MoveProgressContext);
  if (!ctx) {
    // Fallback for tests that render TransferWidget without the provider.
    return { moves: [], dismissMove: () => {}, clearCompleted: () => {} };
  }
  return ctx;
}
