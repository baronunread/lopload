import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { SetupForm } from "./SetupForm";
import { Confetti } from "./Confetti";

export interface OnboardingProps {
  /** Called once the user is ready to move into the main view. */
  onDone: (conn: Connection) => void;
}

/**
 * First-run flow, shown only when there are zero storage connections.
 * Step 1 asks for a storage connection (via SetupForm); once it's saved,
 * step 2 celebrates with a confetti burst and hands off to the main view.
 */
export function Onboarding({ onDone }: OnboardingProps) {
  const [step, setStep] = useState<"connect" | "done">("connect");
  const [saved, setSaved] = useState<Connection | null>(null);

  return (
    <div className="relative flex h-screen items-center justify-center bg-kumo-canvas p-8">
      <AnimatePresence mode="wait">
        {step === "connect" ? (
          <motion.div
            key="connect"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.25 }}
            className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-kumo-base p-8 ring-1 ring-kumo-line"
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
            className="relative flex w-full max-w-md flex-col items-center gap-4 rounded-xl bg-kumo-base p-8 text-center ring-1 ring-kumo-line"
          >
            <Confetti />
            <h1 className="lopload-heading text-2xl font-semibold">That's all!</h1>
            <p className="lopload-body text-kumo-subtle">Enjoy browsing and uploading.</p>
            <Button
              variant="primary"
              onClick={() => {
                if (saved) onDone(saved);
              }}
            >
              Start browsing
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
