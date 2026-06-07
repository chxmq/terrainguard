import { Info, TrendingUp, Triangle, BarChart3, Layers } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { InfoPanel } from "@/components/panels/InfoPanel";
import { MsaPanel } from "@/components/panels/MsaPanel";
import { TawsPanel } from "@/components/panels/TawsPanel";
import { CfitPanel } from "@/components/panels/CfitPanel";
import { LayersPanel } from "@/components/panels/LayersPanel";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "info",   Icon: Info,       label: "Info" },
  { value: "msa",    Icon: TrendingUp, label: "MSA" },
  { value: "taws",   Icon: Triangle,   label: "TAWS" },
  { value: "cfit",   Icon: BarChart3,  label: "CFIT" },
  { value: "layers", Icon: Layers,     label: "Layers" },
] as const;

export function Sidebar() {
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-r border-border bg-card">
      <Tabs defaultValue="info" className="flex h-full flex-col">
        {/* Tab bar */}
        <TabsList className="grid h-auto grid-cols-5 gap-0 rounded-none border-b border-border bg-secondary/40 p-0">
          {TABS.map(({ value, Icon, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-none border-b-2 border-transparent py-3",
                "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
                "transition-colors hover:text-foreground",
                "data-[state=active]:border-primary data-[state=active]:bg-primary/8 data-[state=active]:text-primary",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto p-4">
          <TabsContent value="info"><InfoPanel /></TabsContent>
          <TabsContent value="msa"><MsaPanel /></TabsContent>
          <TabsContent value="taws"><TawsPanel /></TabsContent>
          <TabsContent value="cfit"><CfitPanel /></TabsContent>
          <TabsContent value="layers"><LayersPanel /></TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
