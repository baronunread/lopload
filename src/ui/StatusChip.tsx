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
}

/**
 * Renders one of the status states from the spec as a labeled chip (six
 * counting both terminal-success states, "Uploaded ✓"/"Downloaded ✓").
 * "Sending" additionally shows a live Meter.
 */
export function StatusChip({ state, direction }: StatusChipProps) {
  const info = chipInfo(state, direction);
  const badge = (
    <Badge
      variant={VARIANT_BY_VISUAL[info.visual]}
      className={info.visual === "amber-pulse" ? "animate-pulse" : undefined}
    >
      {info.label}
    </Badge>
  );

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
