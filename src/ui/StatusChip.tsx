import { Badge, Meter } from "@cloudflare/kumo";
import type { Transfer, TransferState } from "../lib/types";
import { chipInfo } from "./format";

const VARIANT_BY_VISUAL = {
  neutral: "secondary",
  amber: "warning",
  "amber-pulse": "warning",
  mint: "success",
  coral: "error",
} as const;

export interface StatusChipProps {
  state: TransferState;
  direction?: Transfer["direction"];
  /** Called when a failed chip is clicked — retries the transfer. */
  onRetry?: () => void;
}

/**
 * Renders one of the status states from the spec as a labeled chip (six
 * counting both terminal-success states, "Uploaded ✓"/"Downloaded ✓").
 * "Sending" additionally shows a live Meter; "failed" is clickable to retry
 * and is never auto-dismissed by this component.
 */
export function StatusChip({ state, direction, onRetry }: StatusChipProps) {
  const info = chipInfo(state, direction);
  // Badge doesn't forward arbitrary DOM props, so data-state lives on a
  // wrapper element instead — tests key off the wrapper's data-state.
  const badge = (
    <Badge
      variant={VARIANT_BY_VISUAL[info.visual]}
      className={info.visual === "amber-pulse" ? "animate-pulse" : undefined}
    >
      {info.label}
    </Badge>
  );

  if (state.kind === "failed") {
    return (
      <button
        type="button"
        data-state="failed"
        onClick={onRetry}
        className="lopload-settle cursor-pointer border-none bg-transparent p-0"
        aria-label={`${info.label}, click to retry`}
      >
        {badge}
      </button>
    );
  }

  if (state.kind === "sending") {
    return (
      <div data-state="sending" className="flex min-w-40 flex-col gap-1">
        {badge}
        <Meter
          label={direction === "download" ? "Downloading" : "Sending"}
          value={state.percent}
          showValue={false}
          indicatorClassName="bg-kumo-warning"
        />
      </div>
    );
  }

  return (
    <span data-state={info.state} className="lopload-settle inline-flex">
      {badge}
    </span>
  );
}
