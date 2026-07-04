import "./App.css";
import { AppShell } from "./ui/AppShell";
import { ServicesProvider } from "./ui/services";
import { createDemoServices } from "./ui/demoServices";

// TODO(integration agent): replace createDemoServices() with the real
// AppServices implementation wired to src/lib + src/tauri, per the seam
// documented in src/ui/services.ts.
const services = createDemoServices();

function App() {
  return (
    <ServicesProvider value={services}>
      <AppShell />
    </ServicesProvider>
  );
}

export default App;
