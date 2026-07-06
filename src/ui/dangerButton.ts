import type { CSSProperties } from "react";

/**
 * Kumo's `variant="destructive"` computes its background/ring off
 * `--color-kumo-danger` — which in this app's dark theme itself resolves to
 * a pale salmon (#f3a8a0), then gets lightened further via
 * `color-mix(..., white 30%)`. The result reads as pink, not red. Passed as
 * this `style` prop, it overrides those same custom properties (Button
 * spreads its own `style` prop after its computed ones) with a solid
 * Tailwind red instead, for every "Delete"/"Remove" button in the app.
 */
export const SOLID_DANGER_BUTTON_STYLE: CSSProperties = {
  "--kumo-button-emphasis-bg": "var(--color-red-600)",
  "--kumo-button-emphasis-ring": "var(--color-red-700)",
  "--kumo-button-emphasis-gradient-start": "var(--color-red-500)",
  "--kumo-button-emphasis-gradient-end": "var(--color-red-600)",
} as CSSProperties;

/**
 * Same fix for text-only danger elements (icon buttons using
 * `variant="secondary-destructive"`, which is `!text-kumo-danger`, plus
 * plain danger-colored text like the context menu's "Delete" item). The
 * `!important` on Kumo's own class means a plain inline `color` loses to
 * it, so this also needs `!important` to win.
 */
export const SOLID_DANGER_TEXT_STYLE: CSSProperties = {
  color: "var(--color-red-600) !important",
} as CSSProperties;
