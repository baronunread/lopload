import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";

const COLORS = [
  "var(--color-kumo-brand)",
  "var(--color-kumo-success)",
  "var(--color-kumo-warning)",
  "var(--color-kumo-danger)",
  "var(--color-kumo-brand-hover)",
];

// Longest particle animation (1.1s duration + up to 0.15s stagger delay),
// plus a small buffer, before the whole overlay unmounts itself.
const LIFETIME_MS = 1400;

interface Particle {
  id: number;
  angle: number;
  distance: number;
  size: number;
  color: string;
  rounded: boolean;
  delay: number;
}

function makeParticles(count: number): Particle[] {
  // Scale the burst to the viewport (not the card) so it reads as a
  // window-wide celebration rather than a small pop confined to one corner.
  const maxDistance =
    typeof window !== "undefined"
      ? Math.min(window.innerWidth, window.innerHeight) * 0.45
      : 200;

  return Array.from({ length: count }, (_, id) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 80 + Math.random() * maxDistance;
    return {
      id,
      angle,
      distance,
      size: 6 + Math.random() * 8,
      color: COLORS[id % COLORS.length],
      rounded: Math.random() > 0.5,
      delay: Math.random() * 0.15,
    };
  });
}

/**
 * One-shot confetti burst, fired from the center of the viewport. Renders
 * via a portal into `document.body` as a `position: fixed` overlay so it
 * can never be clipped by an ancestor's overflow/transform/stacking
 * context — it bursts across the whole window, not just its mount point.
 * Purely decorative: ignores pointer events, never re-fires, and unmounts
 * itself once the animation finishes.
 */
export function Confetti() {
  const particles = useMemo(() => makeParticles(48), []);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), LIFETIME_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      aria-hidden="true"
    >
      {particles.map((p) => {
        const dx = Math.cos(p.angle) * p.distance;
        const dy = Math.sin(p.angle) * p.distance - 60;
        return (
          <motion.span
            key={p.id}
            className="absolute left-1/2 top-1/2"
            style={{
              width: p.size,
              height: p.size,
              backgroundColor: p.color,
              borderRadius: p.rounded ? "9999px" : "2px",
            }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 0.6, rotate: 0 }}
            animate={{
              x: dx,
              y: [0, dy - 40, dy + 100],
              opacity: [1, 1, 0],
              scale: 1,
              rotate: (Math.random() - 0.5) * 360,
            }}
            transition={{
              duration: 1.1,
              delay: p.delay,
              ease: "easeOut",
              times: [0, 0.5, 1],
            }}
          />
        );
      })}
    </div>,
    document.body,
  );
}
