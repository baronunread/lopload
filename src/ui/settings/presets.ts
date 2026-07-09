// Re-exports the transfer tuning presets for UI consumers (SettingsDialog).
// The definitions live in src/lib/tuning.ts so non-UI code (src/tauri,
// src/services) can use them without depending on src/ui.
export { PRESETS, DEFAULT_TUNING, presetMatching } from "../../lib/tuning";
