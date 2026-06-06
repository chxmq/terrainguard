import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { MapView } from "@/components/MapView";
import { Globe3DView } from "@/components/Globe3DView";
import { Toaster } from "@/components/Toaster";
import { TtciProvider } from "@/state/ttci";
import { ToolsProvider } from "@/state/tools";

export default function App() {
  return (
    <TtciProvider>
      <ToolsProvider>
        <div className="flex h-full flex-col">
          <Header />
          <main className="flex flex-1 overflow-hidden">
            <Sidebar />
            <div className="relative flex-1">
              <MapView />
              <Globe3DView />
            </div>
          </main>
          <Toaster />
        </div>
      </ToolsProvider>
    </TtciProvider>
  );
}
