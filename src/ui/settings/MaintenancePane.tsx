import { Button } from "@cloudflare/kumo";

export interface MaintenancePaneProps {
  connected: boolean;
  cleaning: boolean;
  cleanupResult: string | null;
  onCleanUp: () => void;
}

/** Storage upkeep actions. Disabled (not hidden) when no connection is active. */
export function MaintenancePane({
  connected,
  cleaning,
  cleanupResult,
  onCleanUp,
}: MaintenancePaneProps) {
  return (
    <div>
      <p className="mb-1 text-sm text-kumo-default">Clean up interrupted uploads</p>
      <p className="mb-3 text-xs text-kumo-subtle">
        Removes abandoned multipart upload fragments that still count against storage.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={onCleanUp} disabled={!connected || cleaning}>
          {cleaning ? "Cleaning up…" : "Clean up interrupted uploads"}
        </Button>
        {!connected && (
          <span className="text-xs text-kumo-subtle">Connect to a storage to run cleanup.</span>
        )}
        {connected && cleanupResult && (
          <span className="text-sm text-kumo-subtle tabular-nums">{cleanupResult}</span>
        )}
      </div>
    </div>
  );
}
