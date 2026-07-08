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

export function StatusChip({ state, direction }: StatusChipProps) {
  const info = chipInfo(state, direction);
  const sending = state.kind === "sending";

  if (sending) {
    return (
      <div data-state="sending" className="flex min-w-40 items-center">
        <Meter
          label={direction === "download" ? "Downloading" : "Uploading"}
          value={state.percent}
          showValue
          className="w-full"
          trackClassName="!h-1"
          indicatorClassName="bg-kumo-warning"
        />
      </div>
    );
  }

  return (
    <span data-state={info.state} className="lopload-settle inline-flex">
      <Badge
        variant={VARIANT_BY_VISUAL[info.visual]}
        className={info.visual === "amber-pulse" ? "animate-pulse" : undefined}
      >
        {info.label}
      </Badge>
    </span>
  );
}
