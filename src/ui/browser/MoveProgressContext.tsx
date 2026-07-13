import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MoveProgress } from "../services";
import { useServices } from "../services";

interface MoveProgressCtx {
  moves: MoveProgress[];
  dismissMove: (moveId: string) => void;
  clearCompleted: () => void;
}

const MoveProgressContext = createContext<MoveProgressCtx | null>(null);

export function MoveProgressProvider({ children }: { children: React.ReactNode }) {
  const services = useServices();
  const [moves, setMoves] = useState<MoveProgress[]>([]);
  const dismissedRef = useRef(new Set<string>());

  useEffect(() => {
    // A move emits once per object copied — or once per part of a large one —
    // which for a folder of many small files is far more events than there are
    // frames to draw. Keep only the latest state per move and flush on the next
    // frame, so a big move can't turn into a re-render storm.
    let pending = new Map<string, MoveProgress>();
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      const batch = pending;
      pending = new Map();
      setMoves((prev) => {
        const next = prev.slice();
        for (const event of batch.values()) {
          if (dismissedRef.current.has(event.moveId)) continue;
          const idx = next.findIndex((m) => m.moveId === event.moveId);
          if (idx === -1) next.push(event);
          else next[idx] = event;
        }
        return next;
      });
    };

    const unsub = services.browser.subscribeMoves((event) => {
      pending.set(event.moveId, event);
      frame ??= requestAnimationFrame(flush);
    });

    return () => {
      unsub();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [services]);

  const dismissMove = useCallback((moveId: string) => {
    dismissedRef.current.add(moveId);
    setMoves((prev) => prev.filter((m) => m.moveId !== moveId));
  }, []);

  const clearCompleted = useCallback(() => {
    setMoves((prev) =>
      prev.filter((m) => m.status === "moving"),
    );
  }, []);

  return (
    <MoveProgressContext.Provider value={{ moves, dismissMove, clearCompleted }}>
      {children}
    </MoveProgressContext.Provider>
  );
}

export function useMoveProgress(): MoveProgressCtx {
  const ctx = useContext(MoveProgressContext);
  if (!ctx) {
    // Fallback for tests that render TransferWidget without the provider.
    return { moves: [], dismissMove: () => {}, clearCompleted: () => {} };
  }
  return ctx;
}
