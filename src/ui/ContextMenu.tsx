import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SOLID_DANGER_TEXT_STYLE } from "./dangerButton";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * A minimal right-click menu positioned at the cursor. Kumo's DropdownMenu
 * anchors to a trigger element rather than a point, so a small bespoke
 * popup (styled with the same Kumo semantic tokens) is used here instead.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Menu starts positioned at the requested point, then is nudged back on
  // screen (in a layout effect, before paint) if it would overflow the
  // viewport — e.g. opened from a row near the right/bottom edge on a
  // narrow/touch viewport where there's no room to the point's right.
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setPos({ x: Math.max(margin, Math.min(x, maxX)), y: Math.max(margin, Math.min(y, maxY)) });
    // Re-run only when the requested point changes — items/onClose don't
    // affect positioning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: pos.y, left: pos.x }}
      className="lopload-pop-in z-50 min-w-40 rounded-lg bg-kumo-base p-1 shadow-lg ring-1 ring-kumo-line"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-kumo-tint ${
            item.danger ? "text-kumo-danger" : "text-kumo-default"
          }`}
          style={item.danger ? SOLID_DANGER_TEXT_STYLE : undefined}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
