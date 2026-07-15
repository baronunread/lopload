import "./App.css";
import { AppShell } from "./ui/AppShell";
import { ServicesProvider } from "./ui/services";
import { createTauriHost, isTauriRuntime } from "./services/host.tauri";
import { createAppServices, type Services } from "./services/appServices";

// Built at most once for the life of the process: the services layer caches S3
// clients and TransferEngines, and starts the trash sweep — a second instance
// would resume the same pending transfers on its own engine. Lazily, because
// createTauriHost() only works inside the webview.
let services: Services | null = null;
function getServices(): Services {
  return (services ??= createAppServices(createTauriHost()));
}

function App() {
  // Real services (SQLite + keychain + S3 + TransferEngine) only work inside
  // the Tauri webview — constructing them in a plain browser tab would throw
  // on missing Tauri APIs, so check first and never call createAppServices()
  // outside of it.
  if (!isTauriRuntime()) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-kumo-canvas p-8 text-center">
        <h1 className="lopload-heading text-2xl font-semibold">Lopload requires the desktop app</h1>
        <p className="lopload-body text-kumo-subtle">
          Run <code className="selectable">bun run tauri dev</code> to launch it.
        </p>
      </div>
    );
  }

  return (
    <ServicesProvider value={getServices()}>
      <AppShell />
    </ServicesProvider>
  );
}

export default App;
