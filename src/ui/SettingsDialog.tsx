import { useEffect, useState } from "react";
import { Button, Dialog, Select, Switch } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useServices } from "./services";

export interface SettingsDialogProps {
  onClose: () => void;
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const services = useServices();
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState<boolean>(true);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [concurrentCount, setConcurrentCount] = useState<number>(3);

  useEffect(() => {
    void services.updates.isAutoUpdateEnabled().then(setAutoUpdateEnabledState);
    void services.settings.getDefaultDownloadDir().then(setDownloadDir);
    void services.settings.getConcurrentTransfers().then(setConcurrentCount);
  }, [services]);

  async function handleToggleAutoUpdate(enabled: boolean) {
    setAutoUpdateEnabledState(enabled);
    await services.updates.setAutoUpdateEnabled(enabled);
  }

  async function handleCheckNow() {
    setChecking(true);
    setCheckResult(null);
    try {
      const found = await services.updates.checkForUpdate();
      if (found) {
        setCheckResult(`Version ${found} is available.`);
      } else {
        setCheckResult("You're up to date.");
      }
    } catch {
      setCheckResult("Couldn't check for updates.");
    } finally {
      setChecking(false);
    }
  }

  async function handlePickDownloadDir() {
    const dir = await services.pickDownloadDirectory();
    if (dir) {
      setDownloadDir(dir);
      await services.settings.setDefaultDownloadDir(dir);
    }
  }

  async function handleClearDownloadDir() {
    setDownloadDir(null);
    await services.settings.setDefaultDownloadDir(null);
  }

  async function handleConcurrentChange(value: unknown) {
    const count = typeof value === "number" ? value : 3;
    setConcurrentCount(count);
    await services.settings.setConcurrentTransfers(count);
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-full max-w-md p-6">
        <div className="flex items-center gap-3">
          <Dialog.Title className="m-0">Settings</Dialog.Title>
          <Dialog.Close
            render={(p) => (
              <Button
                variant="ghost"
                shape="square"
                aria-label="Close"
                icon={XIcon}
                className="ml-auto"
                {...p}
              />
            )}
          />
        </div>
        <div className="flex flex-col gap-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-kumo-strong">General</h2>
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 text-sm text-kumo-default">Default download directory</p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={handlePickDownloadDir}>
                    {downloadDir ? "Change" : "Choose"}
                  </Button>
                  {downloadDir && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
                        {downloadDir}
                      </span>
                      <Button variant="ghost" onClick={handleClearDownloadDir}>
                        Clear
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm text-kumo-default">Concurrent transfers</p>
                <Select
                  aria-label="Concurrent transfers"
                  value={concurrentCount}
                  onValueChange={handleConcurrentChange}
                >
                  <Select.Option value={1}>1</Select.Option>
                  <Select.Option value={2}>2</Select.Option>
                  <Select.Option value={3}>3</Select.Option>
                  <Select.Option value={4}>4</Select.Option>
                  <Select.Option value={5}>5</Select.Option>
                </Select>
              </div>
            </div>
          </section>

          <hr className="border-kumo-line" />

          <section>
            <h2 className="mb-3 text-sm font-semibold text-kumo-strong">Updates</h2>
            <Switch
              label="Check for updates automatically"
              checked={autoUpdateEnabled}
              onCheckedChange={handleToggleAutoUpdate}
              controlFirst={false}
            />
            <p className="mt-1 text-xs text-kumo-subtle">
              Manual check always works regardless of this setting.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Button variant="secondary" onClick={handleCheckNow} disabled={checking}>
                {checking ? "Checking\u2026" : "Check for updates now"}
              </Button>
              {checkResult && (
                <span className="text-sm text-kumo-subtle tabular-nums">{checkResult}</span>
              )}
            </div>
          </section>
        </div>

      </Dialog>
    </Dialog.Root>
  );
}
