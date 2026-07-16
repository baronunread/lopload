import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { SetupForm } from "./SetupForm";

/** Soft-settle enter for one staggered piece of the "done" step. */
function settle(delay: number) {
  return {
    initial: { opacity: 0, y: 8 },
    animate: {
      opacity: 1,
      y: 0,
      transition: { type: "spring" as const, duration: 0.3, bounce: 0, delay },
    },
  };
}

export interface OnboardingProps {
  /** Called once the user is ready to move into the main view. */
  onDone: (conn: Connection) => void;
}

/**
 * First-run flow, shown only when there are zero storage connections.
 * Step 1 asks for a storage connection (via SetupForm); once it's saved,
 * step 2 marks the moment with a soft-settling checkmark and hands off to
 * the main view.
 */
export function Onboarding({ onDone }: OnboardingProps) {
  const [step, setStep] = useState<"connect" | "done">("connect");
  const [saved, setSaved] = useState<Connection | null>(null);

  return (
    /* The card is centered but the page scrolls when the window is shorter
       than the card (this app usually runs windowed) — `my-auto` on the card
       instead of `items-center` on the flex parent, because a centered flex
       child that overflows its container clips its top edge unreachably. */
    <div className="flex h-screen flex-col items-center overflow-y-auto bg-kumo-canvas p-8">
      {/* initial={false}: the welcome card shouldn't slide in on app launch —
          only the connect → done step change animates. */}
      <AnimatePresence mode="wait" initial={false}>
        {step === "connect" ? (
          <motion.div
            key="connect"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.25 }}
            className="my-auto flex w-full max-w-2xl shrink-0 flex-col gap-4 rounded-xl bg-kumo-base p-8 ring-1 ring-kumo-line"
          >
            <div className="flex flex-col gap-1 text-center">
              <h1 className="lopload-heading text-2xl font-semibold">Welcome to Lopload</h1>
              <p className="lopload-body text-kumo-subtle">
                Connect your storage to get started.
              </p>
            </div>
            <SetupForm
              onSaved={(conn) => {
                setSaved(conn);
                setStep("done");
              }}
            />
          </motion.div>
        ) : (
          <motion.div
            key="done"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.25 }}
            className="my-auto flex w-full max-w-md shrink-0 flex-col items-center gap-4 rounded-xl bg-kumo-base p-8 text-center ring-1 ring-kumo-line"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
              animate={{
                opacity: 1,
                scale: 1,
                filter: "blur(0px)",
                transition: { type: "spring", duration: 0.3, bounce: 0, delay: 0.1 },
              }}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-kumo-success-tint"
            >
              <CheckIcon size={28} weight="bold" className="text-kumo-success" aria-hidden />
            </motion.div>
            <motion.h1 {...settle(0.2)} className="lopload-heading text-2xl font-semibold">
              That's all!
            </motion.h1>
            <motion.p {...settle(0.3)} className="lopload-body text-kumo-subtle">
              Enjoy browsing and uploading.
            </motion.p>
            <motion.div {...settle(0.4)}>
              <Button
                variant="primary"
                onClick={() => {
                  if (saved) onDone(saved);
                }}
              >
                Start browsing
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
