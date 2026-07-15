import { lazy, Suspense, useEffect, useState } from "react";
import { Toasty } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { useServices } from "./services";
import { AutoUpdateProvider } from "./AutoUpdateContext";
import { UpdateBanner } from "./UpdateBanner";
import { ConnectionSwitcher } from "./ConnectionSwitcher";
import { AddStorageDialog } from "./AddStorageDialog";
import { TransferWidget } from "./TransferWidget";
import { ManageConnectionsDialog } from "./ManageConnectionsDialog";
import { GearIcon } from "@phosphor-icons/react";
import { SettingsDialog } from "./SettingsDialog";
import { ThemeToggle } from "./ThemeToggle";
import { MoveProgressProvider } from "./browser/MoveProgressContext";

const Onboarding = lazy(() => import("./Onboarding").then((m) => ({ default: m.Onboarding })));
const RemoteBrowser = lazy(() => import("./RemoteBrowser").then((m) => ({ default: m.RemoteBrowser })));

function AppShellInner() {
  const services = useServices();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      services.connections.list(),
      services.settings.getLastConnectionId(),
    ]).then(([list, lastId]) => {
      if (cancelled) return;
      setConnections(list);
      if (list.length > 0) {
        const target = lastId ? list.find((c) => c.id === lastId) ?? list[0] : list[0];
        setCurrentId(target.id);
        setPrefix(target.lastPrefix);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = connections.find((c) => c.id === currentId) ?? null;

  function switchTo(id: string) {
    const conn = connections.find((c) => c.id === id);
    setCurrentId(id);
    setPrefix(conn?.lastPrefix ?? "");
    void services.settings.setLastConnectionId(id);
  }

  function handleSaved(conn: Connection) {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === conn.id);
      if (idx === -1) return [...prev, conn];
      const next = prev.slice();
      next[idx] = conn;
      return next;
    });
    setCurrentId(conn.id);
    setPrefix(conn.lastPrefix);
    setShowSetup(false);
  }

  function handleDeleted(id: string) {
    const remaining = connections.filter((c) => c.id !== id);
    setConnections(remaining);
    if (id === currentId) {
      const fallback = remaining[0] ?? null;
      setCurrentId(fallback?.id ?? null);
      setPrefix(fallback?.lastPrefix ?? "");
    }
    if (remaining.length === 0) setShowManage(false);
  }

  if (connections.length === 0) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center bg-kumo-canvas"><p className="text-kumo-subtle">Loading…</p></div>}>
        <Onboarding onDone={handleSaved} />
      </Suspense>
    );
  }

  if (!current) return null;

  return (
    <div className="flex h-screen flex-col bg-kumo-canvas">
      <UpdateBanner />
      <header className="flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <h1 className="lopload-heading shrink-0 text-xl font-semibold">Lopload</h1>
        <div className="flex min-w-0 items-center gap-2">
          <ConnectionSwitcher
            connections={connections}
            currentId={currentId}
            onSwitch={switchTo}
            onAddStorage={() => setShowSetup(true)}
            onManageStorage={() => setShowManage(true)}
          />
          <button
            type="button"
            aria-label="Settings"
            className="relative flex h-8 w-8 items-center justify-center rounded-full text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96]"
            onClick={() => setShowSettings(true)}
          >
            <GearIcon size={16} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {showSettings && (
        <SettingsDialog onClose={() => setShowSettings(false)} connectionId={currentId} />
      )}

      {showSetup && (
        <AddStorageDialog onSaved={handleSaved} onClose={() => setShowSetup(false)} />
      )}

      {showManage && (
        <ManageConnectionsDialog
          connections={connections}
          onClose={() => setShowManage(false)}
          onDeleted={handleDeleted}
        />
      )}
      <MoveProgressProvider>
        <main className="relative flex-1 overflow-auto p-4">
          <section className="h-full min-h-[40vh] overflow-auto rounded-lg bg-kumo-base p-4 ring-1 ring-kumo-line">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><p className="text-kumo-subtle">Loading…</p></div>}>
              <RemoteBrowser connectionId={current.id} prefix={prefix} onNavigate={setPrefix} />
            </Suspense>
          </section>
        </main>

        <TransferWidget connectionId={current.id} />
      </MoveProgressProvider>
    </div>
  );
}

/** Top-level app layout: header switcher + remote browser + floating transfer widget. */
export function AppShell() {
  return (
    <Toasty>
      <AutoUpdateProvider>
        <AppShellInner />
      </AutoUpdateProvider>
    </Toasty>
  );
}
