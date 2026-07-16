import { Button, Meter } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useAutoUpdateContext } from "./AutoUpdateContext";

/** Non-intrusive bar pinned to the bottom of the app once an update is found.
 * Fixed rather than in the document flow, so it overlays instead of shifting
 * the header and content when it appears or disappears. Drives the
 * two-click flow: "Update" starts the download (progress shown in place),
 * then "Restart now" relaunches into the staged build. Renders nothing
 * until there's something to show. */
export function UpdateBanner() {
  const { banner, phase, percent, startDownload, relaunch, dismiss } = useAutoUpdateContext();
  if (!banner) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-kumo-line bg-kumo-elevated px-4 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <span className="font-medium text-kumo-strong">{banner.title}</span>
        {banner.body && phase !== "downloading" && (
          <span className="ml-2 text-kumo-subtle">{banner.body}</span>
        )}
      </div>

      {phase === "downloading" && (
        <Meter
          label="Downloading update"
          value={percent}
          showValue
          className="w-44"
          trackClassName="!h-1"
        />
      )}

      {banner.actionLabel && (
        <Button
          variant="primary"
          onClick={phase === "ready" ? relaunch : startDownload}
        >
          {banner.actionLabel}
        </Button>
      )}

      <Button
        variant="ghost"
        shape="square"
        aria-label="Dismiss update notice"
        icon={XIcon}
        onClick={dismiss}
      />
    </div>
  );
}
