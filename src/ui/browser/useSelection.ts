import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { RemoteEntry } from "../../lib/types";

export interface UseSelectionResult {
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Click-to-select: plain click selects only this row, cmd/ctrl-click
   * toggles it in/out of the selection, and shift-click extends the
   * selection to every row between the last-clicked row and this one. */
  handleRowClick: (entry: RemoteEntry, e: ReactMouseEvent) => void;
  clear: () => void;
}

/** Row multi-selection: click/cmd-click/shift-range. Doesn't wire up its own
 * Escape handling — the caller coordinates that with any other Escape-clears
 * behavior (e.g. the type-to-filter box takes priority) and calls `clear()`.
 * `rows` should be the currently displayed (sorted + filtered) list, since
 * shift-range keys off it. */
export function useSelection(rows: RemoteEntry[]): UseSelectionResult {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedKey = useRef<string | null>(null);

  function clear() {
    setSelected(new Set());
    lastClickedKey.current = null;
  }

  function handleRowClick(entry: RemoteEntry, e: ReactMouseEvent) {
    if (e.shiftKey && lastClickedKey.current) {
      const startIdx = rows.findIndex((r) => r.key === lastClickedKey.current);
      const endIdx = rows.findIndex((r) => r.key === entry.key);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        setSelected(new Set(rows.slice(from, to + 1).map((r) => r.key)));
      }
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.key)) next.delete(entry.key);
        else next.add(entry.key);
        return next;
      });
      lastClickedKey.current = entry.key;
      return;
    }
    setSelected(new Set([entry.key]));
    lastClickedKey.current = entry.key;
  }

  return { selected, setSelected, handleRowClick, clear };
}
