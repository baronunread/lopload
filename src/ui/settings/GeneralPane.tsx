import { Button } from "@cloudflare/kumo";

export interface GeneralPaneProps {
  downloadDir: string | null;
  onPickDownloadDir: () => void;
  onClearDownloadDir: () => void;
}

/** Default download directory — the only General knob today. */
export function GeneralPane({
  downloadDir,
  onPickDownloadDir,
  onClearDownloadDir,
}: GeneralPaneProps) {
  return (
    <div>
      <p className="mb-1 text-sm text-kumo-default">Default download directory</p>
      <p className="mb-2 text-xs text-kumo-subtle">
        Where downloads land when you don't pick a folder for a specific transfer.
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onPickDownloadDir}>
          {downloadDir ? "Change" : "Choose"}
        </Button>
        {downloadDir && (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">{downloadDir}</span>
            <Button variant="ghost" onClick={onClearDownloadDir}>
              Clear
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
