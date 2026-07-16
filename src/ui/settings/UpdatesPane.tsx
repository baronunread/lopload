import { Button, Switch } from "@cloudflare/kumo";

export interface UpdatesPaneProps {
  portable: boolean;
  autoUpdateEnabled: boolean;
  onToggleAutoUpdate: (enabled: boolean) => void;
  checking: boolean;
  checkResult: string | null;
  onCheckNow: () => void;
}

/** Auto-update switch + manual check, or a portable-build notice. */
export function UpdatesPane({
  portable,
  autoUpdateEnabled,
  onToggleAutoUpdate,
  checking,
  checkResult,
  onCheckNow,
}: UpdatesPaneProps) {
  if (portable) {
    return (
      <p className="text-xs text-kumo-subtle">
        Automatic updates aren't available for the portable version. Download new releases from
        the GitHub releases page.
      </p>
    );
  }

  return (
    <>
      <Switch
        label="Check for updates automatically"
        checked={autoUpdateEnabled}
        onCheckedChange={onToggleAutoUpdate}
        controlFirst={false}
      />
      <p className="mt-1 text-xs text-kumo-subtle">
        Manual check always works regardless of this setting.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button variant="secondary" onClick={onCheckNow} disabled={checking}>
          {checking ? "Checking…" : "Check for updates now"}
        </Button>
        {checkResult && (
          <span className="text-sm text-kumo-subtle tabular-nums">{checkResult}</span>
        )}
      </div>
    </>
  );
}
