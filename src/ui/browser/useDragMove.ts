import { useRef, useState, type DragEvent } from "react";

/** Custom drag MIME type for internal row drag-to-move. Kept distinct from
 * the browser's native "Files" drag type (used for OS file drops, which are
 * handled separately via the Tauri onDragDropEvent bridge) so a move-drag
 * can never be mistaken for an incoming file upload. */
export const MOVE_DRAG_TYPE = "application/x-lopload-key";

export type DragChipVariant = "folder" | "file" | "files";

export interface DragChipRefs {
  chipRef: React.RefObject<HTMLDivElement | null>;
  labelRef: React.RefObject<HTMLSpanElement | null>;
  folderIconRef: React.RefObject<HTMLSpanElement | null>;
  fileIconRef: React.RefObject<HTMLSpanElement | null>;
  filesIconRef: React.RefObject<HTMLSpanElement | null>;
}

/** Parses the payload written to the custom drag MIME type: a JSON array of
 * the keys being moved (one, or the whole selection). */
export function parseDragKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // Fall through — treat the raw string as a single legacy key.
  }
  return raw ? [raw] : [];
}

export interface UseDragMoveOptions {
  /** Moves every key in `fromKeys` to live under `toPrefix`. */
  onMove: (fromKeys: string[], toPrefix: string) => Promise<void>;
}

export interface UseDragMoveResult {
  dropTarget: string | null;
  chipRefs: DragChipRefs;
  /** Drag handlers for a valid drop target (a folder row, or an ancestor
   * breadcrumb) that only react to internal row drags, never OS file drags. */
  dropTargetHandlers: (toPrefix: string) => {
    onDragOver: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  /** Renders the compact "chip" drag image (a small preview centered under
   * the cursor) instead of the browser's default, which would otherwise drag
   * the whole (huge) row or its text. */
  showDragChip: (e: DragEvent, label: string, variant: DragChipVariant) => void;
  clearDropTarget: () => void;
}

/** Row drag-to-move: tracks the current drop target, renders a drag-ghost
 * chip in place of the browser's default drag image, and dispatches moves
 * via `onMove`. Independent of OS file drag-drop (uploads), which the caller
 * handles separately. */
export function useDragMove({ onMove }: UseDragMoveOptions): UseDragMoveResult {
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const chipRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const folderIconRef = useRef<HTMLSpanElement>(null);
  const fileIconRef = useRef<HTMLSpanElement>(null);
  const filesIconRef = useRef<HTMLSpanElement>(null);

  function showDragChip(e: DragEvent, label: string, variant: DragChipVariant) {
    const chip = chipRef.current;
    const labelEl = labelRef.current;
    if (!chip || !labelEl) return;
    const iconRefs = [
      ["folder", folderIconRef],
      ["file", fileIconRef],
      ["files", filesIconRef],
    ] as const;
    labelEl.textContent = label;
    for (const [key, ref] of iconRefs) {
      if (ref.current) ref.current.style.display = key === variant ? "" : "none";
    }
    try {
      // Test environments (happy-dom/jsdom) either omit this or throw — the
      // custom drag image is a visual nicety only, never load-bearing.
      e.dataTransfer.setDragImage?.(chip, 20, 20);
    } catch {
      // ignored
    } finally {
      // The browser rasterizes the drag image synchronously inside
      // setDragImage, so it's safe to blank the (permanently off-screen)
      // chip right back out — otherwise its text would be a second,
      // always-present copy of every row's name in the DOM.
      labelEl.textContent = "";
      for (const [, ref] of iconRefs) {
        if (ref.current) ref.current.style.display = "none";
      }
    }
  }

  function dropTargetHandlers(toPrefix: string) {
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      },
      onDragEnter: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(toPrefix);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.stopPropagation();
        setDropTarget((current) => (current === toPrefix ? null : current));
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        const fromKeys = parseDragKeys(e.dataTransfer.getData(MOVE_DRAG_TYPE));
        void onMove(fromKeys, toPrefix);
      },
    };
  }

  return {
    dropTarget,
    chipRefs: { chipRef, labelRef, folderIconRef, fileIconRef, filesIconRef },
    dropTargetHandlers,
    showDragChip,
    clearDropTarget: () => setDropTarget(null),
  };
}
