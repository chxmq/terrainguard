import { useEffect, useMemo, useState } from "react";
import {
  Info, TrendingUp, Triangle, BarChart3, Waypoints, Settings, History,
  PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import { InfoPanel } from "@/components/panels/InfoPanel";
import { MsaPanel } from "@/components/panels/MsaPanel";
import { TawsPanel } from "@/components/panels/TawsPanel";
import { CfitPanel } from "@/components/panels/CfitPanel";
import { UasPanel } from "@/components/panels/UasPanel";
import { SettingsPanel } from "@/components/panels/SettingsPanel";
import { HistoryPanel } from "@/components/panels/HistoryPanel";
import { useTools } from "@/state/tools";
import { cn } from "@/lib/utils";

type TabValue = "info" | "msa" | "taws" | "cfit" | "history" | "uas" | "settings";

interface NavItem {
  value: TabValue;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  tool?: "msa" | "taws" | "uas";
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Explore",
    items: [
      { value: "info", Icon: Info, label: "Overview", hint: "Terrain risk at a point" },
    ],
  },
  {
    label: "Tools",
    items: [
      { value: "msa", Icon: TrendingUp, label: "Route", hint: "Safe altitude along a path", tool: "msa" },
      { value: "taws", Icon: Triangle, label: "Alerts", hint: "Look-ahead terrain warnings", tool: "taws" },
      { value: "uas", Icon: Waypoints, label: "UAS", hint: "Drone corridor risk assessment", tool: "uas" },
    ],
  },
  {
    label: "Records",
    items: [
      { value: "cfit", Icon: BarChart3, label: "Accidents", hint: "Historical crash validation" },
      { value: "history", Icon: History, label: "History", hint: "Saved pins and notes on the map" },
    ],
  },
];

const SETTINGS_ITEM: NavItem = {
  value: "settings",
  Icon: Settings,
  label: "Settings",
  hint: "Display, tools, terrain data, and TTCI reference",
};

function isItemVisible(item: NavItem, flags: { showMsaTab: boolean; showTawsTab: boolean; showUasTab: boolean }) {
  if (item.tool === "msa") return flags.showMsaTab;
  if (item.tool === "taws") return flags.showTawsTab;
  if (item.tool === "uas") return flags.showUasTab;
  return true;
}

function PanelBody({ tab }: { tab: TabValue }) {
  switch (tab) {
    case "info": return <InfoPanel />;
    case "msa": return <MsaPanel />;
    case "taws": return <TawsPanel />;
    case "cfit": return <CfitPanel />;
    case "history": return <HistoryPanel />;
    case "uas": return <UasPanel />;
    case "settings": return <SettingsPanel />;
  }
}

export function Sidebar() {
  const { showMsaTab, showTawsTab, showUasTab, sidebarOpen, setSidebarOpen } = useTools();
  const [activeTab, setActiveTab] = useState<TabValue>("info");

  const flags = { showMsaTab, showTawsTab, showUasTab };

  const visibleGroups = useMemo(() => {
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((item) => isItemVisible(item, flags)),
    })).filter((g) => g.items.length > 0);
  }, [showMsaTab, showTawsTab, showUasTab]);

  const allVisible = useMemo(() => {
    return [...visibleGroups.flatMap((g) => g.items), SETTINGS_ITEM];
  }, [visibleGroups]);

  const active = allVisible.find((t) => t.value === activeTab) ?? allVisible[0];

  useEffect(() => {
    if (!allVisible.some((t) => t.value === activeTab)) {
      setActiveTab("info");
    }
  }, [allVisible, activeTab]);

  const selectTab = (value: TabValue) => {
    if (activeTab === value && sidebarOpen) {
      setSidebarOpen(false);
      return;
    }
    setActiveTab(value);
    if (!sidebarOpen) setSidebarOpen(true);
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 overflow-hidden border-r border-border bg-card transition-[width] duration-200 ease-out",
        sidebarOpen ? "w-[380px]" : "w-[52px]",
      )}
    >
      {/* Icon rail — always visible */}
      <nav
        className="flex w-[52px] shrink-0 flex-col bg-secondary/40 py-2"
        aria-label="Sidebar navigation"
      >
        {visibleGroups.map((group, gi) => (
          <div key={group.label} className={cn(gi > 0 && "mt-1 border-t border-border/60 pt-1")}>
            {group.items.map(({ value, Icon, label }) => (
              <NavButton
                key={value}
                label={label}
                active={activeTab === value}
                onClick={() => selectTab(value)}
              >
                <Icon className="h-[18px] w-[18px]" />
              </NavButton>
            ))}
          </div>
        ))}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? "Collapse panel" : "Expand panel"}
          aria-label={sidebarOpen ? "Collapse panel" : "Expand panel"}
          className="mx-1.5 mb-1 flex h-10 w-[calc(100%-12px)] items-center justify-center rounded-md border border-border/60 text-muted-foreground transition-colors hover:border-foreground/20 hover:bg-background/60 hover:text-foreground"
        >
          {sidebarOpen
            ? <PanelLeftClose className="h-[18px] w-[18px]" />
            : <PanelLeftOpen className="h-[18px] w-[18px]" />}
        </button>

        <NavButton
          label={SETTINGS_ITEM.label}
          active={activeTab === "settings"}
          onClick={() => selectTab("settings")}
        >
          <SETTINGS_ITEM.Icon className="h-[18px] w-[18px]" />
        </NavButton>
      </nav>

      {/* Content panel — slides away when collapsed */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col border-l border-border transition-opacity duration-200",
          sidebarOpen ? "opacity-100" : "pointer-events-none w-0 opacity-0",
        )}
      >
        <header className="shrink-0 border-b border-border px-4 py-3.5">
          <h2 className="text-title">{active?.label}</h2>
          {active && (
            <p className="text-subtitle mt-1 leading-snug">{active.hint}</p>
          )}
        </header>

        <div className="flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
          {active && <PanelBody tab={active.value} />}
        </div>
      </div>
    </aside>
  );
}

function NavButton({
  label, active, onClick, children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "relative mx-1.5 flex h-10 w-[calc(100%-12px)] items-center justify-center rounded-md transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-foreground/80" />
      )}
      {children}
    </button>
  );
}
