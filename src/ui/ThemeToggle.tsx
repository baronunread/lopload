import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";

/** localStorage key holding the user's explicit theme override; when unset,
 * the inline script in index.html follows the OS preference instead. */
const STORAGE_KEY = "lopload-theme";

type Mode = "light" | "dark";

function currentMode(): Mode {
  return document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
}

const SHOWN = { opacity: 1, scale: 1, filter: "blur(0px)" };
const HIDDEN = { opacity: 0, scale: 0.25, filter: "blur(4px)" };
const ICON_SPRING = { type: "spring", duration: 0.3, bounce: 0 } as const;

/**
 * Header light/dark toggle. Flips `data-mode` on <html> (which drives every
 * Kumo light-dark() token) and persists the choice, overriding the
 * OS-following default from index.html's inline script.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(currentMode);

  // data-mode can also change from outside this button (the head script's
  // OS-preference listener) — watch the attribute so the icon never lies.
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(currentMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-mode"],
    });
    return () => observer.disconnect();
  }, []);

  function toggle() {
    const next: Mode = mode === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-mode", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the flip still applies for this session.
    }
  }

  return (
    <button
      type="button"
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggle}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-kumo-subtle transition-transform after:absolute after:-inset-0.5 hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96]"
    >
      {/* Both icons stay mounted and cross-fade in place, so a quick
          double-toggle interrupts mid-animation instead of restarting. */}
      <motion.span
        initial={false}
        animate={mode === "dark" ? SHOWN : HIDDEN}
        transition={ICON_SPRING}
        className="flex"
        aria-hidden
      >
        <MoonIcon size={18} />
      </motion.span>
      <motion.span
        initial={false}
        animate={mode === "light" ? SHOWN : HIDDEN}
        transition={ICON_SPRING}
        className="absolute flex"
        aria-hidden
      >
        <SunIcon size={18} />
      </motion.span>
    </button>
  );
}
