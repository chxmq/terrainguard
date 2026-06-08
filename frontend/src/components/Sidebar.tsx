import { Info, TrendingUp, Triangle, BarChart3, Layers } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { InfoPanel } from "@/components/panels/InfoPanel";
import { MsaPanel } from "@/components/panels/MsaPanel";
import { TawsPanel } from "@/components/panels/TawsPanel";
import { CfitPanel } from "@/components/panels/CfitPanel";
import { LayersPanel } from "@/components/panels/LayersPanel";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "info",   Icon: Info,       label: "Overview",   hint: "Terrain risk at a point" },
  { value: "msa",    Icon: TrendingUp, label: "Route",      hint: "Safe altitude along a path" },
  { value: "taws",   Icon: Triangle,   label: "Alerts",     hint: "Look-ahead terrain warnings" },
  { value: "cfit",   Icon: BarChart3,  label: "Accidents",  hint: "Historical crash validation" },
  { value: "layers", Icon: Layers,     label: "Display",    hint: "Map overlay settings" },
] as const;

export function Sidebar() {
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-r border-border bg-card">
      <Tabs defaultValue="info" className="flex h-full flex-col">
        <TabsList className="grid h-auto grid-cols-5 gap-0 rounded-none border-b border-border bg-secondary/50 p-1">
          {TABS.map(({ value, Icon, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md py-2.5",
                "text-[11px] font-medium text-muted-foreground",
                "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1 overflow-y-auto p-4">
          {TABS.map(({ value, hint }) => (
            <TabsContent key={value} value={value} className="mt-0">
              <p className="mb-4 text-sm text-muted-foreground">{hint}</p>
              {value === "info" && <InfoPanel />}
              {value === "msa" && <MsaPanel />}
              {value === "taws" && <TawsPanel />}
              {value === "cfit" && <CfitPanel />}
              {value === "layers" && <LayersPanel />}
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </aside>
  );
}
