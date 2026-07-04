import "./App.css";
import { AppShell } from "./ui/AppShell";
import { ServicesProvider } from "./ui/services";
import { createDemoServices } from "./ui/demoServices";
import { createRealServices, isTauriRuntime } from "./services/real";

// Inside the Tauri webview, use the real services (SQLite + keychain + S3 +
// TransferEngine). In a plain browser tab (e.g. `bun run dev` opened
// directly, or CI previews) fall back to the in-memory demo services so the
// app still renders something instead of throwing on missing Tauri APIs.
const services = isTauriRuntime() ? createRealServices() : createDemoServices();

function App() {
  return (
    <ServicesProvider value={services}>
      <AppShell />
    </ServicesProvider>
  );
}

export default App;
