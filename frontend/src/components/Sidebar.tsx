import { Info, TrendingUp, Triangle, BarChart3, Layers } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { InfoPanel } from "@/components/panels/InfoPanel";
import { MsaPanel } from "@/components/panels/MsaPanel";
import { TawsPanel } from "@/components/panels/TawsPanel";
import { CfitPanel } from "@/components/panels/CfitPanel";
import { LayersPanel } from "@/components/panels/LayersPanel";

export function Sidebar() {
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-r border-border bg-card/40">
      <Tabs defaultValue="info" className="flex h-full flex-col">
        <TabsList className="m-3 grid grid-cols-5 gap-1 bg-transparent">
          <TabsTrigger value="info" className="flex-col gap-1 py-2"><Info className="h-4 w-4" />Info</TabsTrigger>
          <TabsTrigger value="msa" className="flex-col gap-1 py-2"><TrendingUp className="h-4 w-4" />MSA</TabsTrigger>
          <TabsTrigger value="taws" className="flex-col gap-1 py-2"><Triangle className="h-4 w-4" />TAWS</TabsTrigger>
          <TabsTrigger value="cfit" className="flex-col gap-1 py-2"><BarChart3 className="h-4 w-4" />CFIT</TabsTrigger>
          <TabsTrigger value="layers" className="flex-col gap-1 py-2"><Layers className="h-4 w-4" />Layers</TabsTrigger>
        </TabsList>
        <div className="flex-1 overflow-y-auto p-4 pt-1">
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
