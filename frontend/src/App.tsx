import { AmbientChrome } from "@/components/AmbientChrome";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { MapView } from "@/components/MapView";
import { Globe3DView } from "@/components/Globe3DView";
import { Toaster } from "@/components/Toaster";
import { RegionSync } from "@/components/RegionSync";
import { TtciProvider } from "@/state/ttci";
import { ToolsProvider, useTools } from "@/state/tools";

function MapPane() {
  const { view } = useTools();
  return (
    <div className="relative flex-1 overflow-hidden">
      {view === "2d" && <MapView />}
      <Globe3DView />
    </div>
  );
}

export default function App() {
  return (
    <TtciProvider>
      <ToolsProvider>
        <RegionSync />
        <div className="relative flex h-full flex-col">
          <AmbientChrome />
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Header />
            <main className="flex flex-1 overflow-hidden">
              <Sidebar />
              <MapPane />
            </main>
          </div>
          <Toaster />
        </div>
      </ToolsProvider>
    </TtciProvider>
  );
}
