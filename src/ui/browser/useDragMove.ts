import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export type DragChipVariant = "folder" | "file" | "files";

/** Everything the ghost chip needs to render one in-progress drag. */
export interface ActiveDrag {
  keys: string[];
  label: string;
  variant: DragChipVariant;
  /** The dragged file's own thumbnail, shown instead of the generic file
   * glyph when the row being dragged has a rendered preview. */
  thumbnailSrc?: string;
  /** The dragged file's name, used to pick a per-file-type icon (pdf, zip,
   * …) when there's no thumbnail. Only set for single-file drags. */
  fileName?: string;
  /** Where the ghost first appears (the press point); afterwards the hook
   * moves it directly via `ghostRef`, off React's render path. */
  x: number;
  y: number;
}

export interface DragSpec {
  keys: string[];
  label: string;
  variant: DragChipVariant;
  thumbnailSrc?: string;
  fileName?: string;
  /** Fired once the press actually becomes a drag (threshold crossed) —
   * e.g. to collapse the selection down to the dragged row. */
  onBegin?: () => void;
}

/** How far the pointer must travel from the press point before a press
 * becomes a drag — keeps plain clicks and double-clicks from ever starting
 * one. */
const DRAG_THRESHOLD_PX = 4;

/** Ghost offset from the cursor, so the pointer never covers the chip. */
const GHOST_OFFSET_PX = 14;

export interface UseDragMoveOptions {
  /** Moves every key in `fromKeys` to live under `toPrefix`. */
  onMove: (fromKeys: string[], toPrefix: string) => Promise<void>;
}

export interface UseDragMoveResult {
  /** The drag in progress, if any — render the ghost chip off this. */
  drag: ActiveDrag | null;
  dropTarget: string | null;
  /** Attach to the ghost chip so the hook can move it with the cursor. */
  ghostRef: React.RefObject<HTMLDivElement | null>;
  /** Call from a row's onMouseDown; the press only becomes a drag once the
   * cursor moves past the threshold, so clicks pass through untouched. */
  beginPress: (e: ReactMouseEvent, spec: DragSpec) => void;
  /** Hover handlers for a valid drop target (a folder row, or an ancestor
   * breadcrumb). Only react while a drag is actually in progress. */
  dropTargetHandlers: (toPrefix: string) => {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
}

/**
 * Row drag-to-move, driven entirely by pointer events instead of HTML5
 * drag-and-drop. Native DnD can't work in the real app: with Tauri's
 * `dragDropEnabled` on, wry replaces WKWebView's native drop handling (to
 * emit its own file-drop events), so DOM drop events never fire for
 * internal drags — the drag would start but could never land. Pointer
 * events sidestep that, and the ghost becomes a live element that follows
 * the cursor rather than a rasterized setDragImage snapshot (which WebKit
 * rendered as a generic rectangle anyway).
 */
export function useDragMove({ onMove }: UseDragMoveOptions): UseDragMoveResult {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const ghostRef = useRef<HTMLDivElement>(null);
  // Listener-visible mirrors of the states above (document-level handlers
  // are attached once per press and would otherwise close over stale values).
  const dragRef = useRef<ActiveDrag | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  function setDragBoth(value: ActiveDrag | null) {
    dragRef.current = value;
    setDrag(value);
  }

  function setDropTargetBoth(value: string | null) {
    dropTargetRef.current = value;
    setDropTarget(value);
  }

  function positionGhost(x: number, y: number) {
    const ghost = ghostRef.current;
    if (!ghost) return;
    ghost.style.left = `${x + GHOST_OFFSET_PX}px`;
    ghost.style.top = `${y + GHOST_OFFSET_PX}px`;
  }

  function beginPress(e: ReactMouseEvent, spec: DragSpec) {
    if (e.button !== 0) return;
    // A press on the row's actions button (or any other control) is a
    // button press, not a drag handle.
    if (e.target instanceof Element && e.target.closest("button")) return;
    const startX = e.clientX;
    const startY = e.clientY;

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        spec.onBegin?.();
        setDragBoth({
          keys: spec.keys,
          label: spec.label,
          variant: spec.variant,
          thumbnailSrc: spec.thumbnailSrc,
          fileName: spec.fileName,
          x: ev.clientX + GHOST_OFFSET_PX,
          y: ev.clientY + GHOST_OFFSET_PX,
        });
        document.body.style.cursor = "grabbing";
        return;
      }
      positionGhost(ev.clientX, ev.clientY);
    };

    const finish = (performDrop: boolean) => {
      const activeDrag = dragRef.current;
      const target = dropTargetRef.current;
      cleanup();
      if (performDrop && activeDrag && target !== null) {
        void onMove(activeDrag.keys, target);
      }
    };

    const handleUp = () => {
      const dragged = dragRef.current !== null;
      finish(true);
      if (dragged) {
        // The mouseup that ends a drag still produces a click on whatever
        // row it happened over — swallow that one click so it can't
        // reset the selection or trigger row actions.
        const swallow = (clickEv: Event) => {
          clickEv.stopPropagation();
          clickEv.preventDefault();
        };
        document.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener("click", swallow, { capture: true }), 0);
      }
    };

    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") finish(false);
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.removeEventListener("keydown", handleKey);
      document.body.style.cursor = "";
      setDragBoth(null);
      setDropTargetBoth(null);
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
    document.addEventListener("keydown", handleKey);
  }

  // A press can outlive the component (e.g. a re-list unmounts it mid-drag).
  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  function dropTargetHandlers(toPrefix: string) {
    return {
      onMouseEnter: () => {
        if (dragRef.current) setDropTargetBoth(toPrefix);
      },
      onMouseLeave: () => {
        if (dropTargetRef.current === toPrefix) setDropTargetBoth(null);
      },
    };
  }

  return { drag, dropTarget, ghostRef, beginPress, dropTargetHandlers };
}
