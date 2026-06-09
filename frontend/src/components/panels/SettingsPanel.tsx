import { Map, Globe2, Layers, Monitor, Moon, Sun, TrendingUp, Triangle, Waypoints } from "lucide-react";
import { useThemeMode } from "@/hooks/useThemeMode";
import { THEME_MODE_LABELS, type ThemeMode } from "@/lib/theme";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { cn } from "@/lib/utils";
import { NOTIFY } from "@/lib/notifications";

const DEM_OPTIONS = [
  { value: "tiles", label: "SRTM 30 m", hint: "AWS Terrain Tiles — fast, global" },
  { value: "copernicus", label: "Copernicus GLO-30", hint: "ESA 30 m — higher quality" },
  { value: "opentopo", label: "OpenTopo", hint: "Requires API key on server" },
] as const;

const TOOL_TOGGLES = [
  {
    key: "msa" as const,
    Icon: TrendingUp,
    label: "Route",
    description: "MSA per sector along a flight path",
  },
  {
    key: "taws" as const,
    Icon: Triangle,
    label: "Alerts",
    description: "TAWS look-ahead terrain warnings",
  },
  {
    key: "uas" as const,
    Icon: Waypoints,
    label: "UAS",
    description: "Corridor TTCI risk scoring",
  },
];

const TTCI_METRICS = [
  { label: "Slope", weight: "30%", method: "Horn's method", desc: "Steepness" },
  { label: "TRI", weight: "30%", method: "Riley 1999", desc: "Ruggedness" },
  { label: "Curvature", weight: "20%", method: "Zevenbergen & Thorne", desc: "Slope change" },
  { label: "Elevation σ", weight: "20%", method: "5×5 window", desc: "Local relief" },
];

const THEME_OPTIONS: { id: ThemeMode; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "system", label: "System", Icon: Monitor },
];

export function SettingsPanel() {
  const { activeRegion, sourceLabel, isSynthetic, activate } = useTtci();
  const tools = useTools();
  const { mode: themeMode, setModeWithTransition } = useThemeMode();

  const recomputeRegion = async () => {
    if (!activeRegion) return;
    const { south, north, west, east } = activeRegion;
    try {
      await activate(
        { south, north, west, east },
        tools.demSource,
        { successMessage: NOTIFY.regionRecomputed },
      );
    } catch {
      /* surfaced via activate */
    }
  };

  const toolFlags = {
    msa: tools.showMsaTab,
    taws: tools.showTawsTab,
    uas: tools.showUasTab,
  };

  const setToolFlag = (key: "msa" | "taws" | "uas", on: boolean) => {
    if (key === "msa") tools.setShowMsaTab(on);
    if (key === "taws") tools.setShowTawsTab(on);
    if (key === "uas") tools.setShowUasTab(on);
  };

  return (
    <Tabs defaultValue="display" className="w-full min-w-0">
      <TabsList className="mb-4 grid h-auto w-full min-w-0 grid-cols-4 gap-0.5 overflow-hidden p-1">
        <TabsTrigger value="display" className="min-w-0 px-1 py-1.5 text-[10px]">Display</TabsTrigger>
        <TabsTrigger value="tools" className="min-w-0 px-1 py-1.5 text-[10px]">Tools</TabsTrigger>
        <TabsTrigger value="data" className="min-w-0 px-1 py-1.5 text-[10px]">Data</TabsTrigger>
        <TabsTrigger value="formula" className="min-w-0 px-1 py-1.5 text-[10px]">Formula</TabsTrigger>
      </TabsList>

      {/* ── Display ── */}
      <TabsContent value="display" className="mt-0 space-y-3">
        <SettingCard title="Theme">
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setModeWithTransition(id)}
                title={THEME_MODE_LABELS[id]}
                aria-label={THEME_MODE_LABELS[id]}
                aria-pressed={themeMode === id}
                className={cn(
                  "flex flex-col items-center justify-center gap-1.5 rounded-md border py-2.5 text-[11px] font-medium transition-colors",
                  themeMode === id
                    ? "border-foreground/25 bg-foreground/5 text-foreground"
                    : "border-border bg-secondary/30 text-muted-foreground hover:border-foreground/15 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </SettingCard>

        <SettingCard title="Map mode">
          <div className="grid grid-cols-2 gap-2">
            {([
              { id: "2d" as const, label: "2D Map", Icon: Map },
              { id: "3d" as const, label: "3D Globe", Icon: Globe2 },
            ]).map(({ id, label, Icon }) => {
              const disabled = id === "3d" && tools.disable3D;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  title={disabled ? "Enable the 3D globe below to use this view" : label}
                  onClick={() => tools.setView(id)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-md border py-2.5 text-[12px] font-medium transition-colors",
                    disabled && "cursor-not-allowed opacity-40",
                    tools.view === id && !disabled
                      ? "border-foreground/25 bg-foreground/5 text-foreground"
                      : "border-border bg-secondary/30 text-muted-foreground hover:border-foreground/15 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </SettingCard>

        <SettingCard title="Layers">
          <div className="space-y-3">
            <SettingRow
              label="TTCI risk overlay"
              hint="Color-coded complexity on the map"
              checked={tools.showOverlay}
              onChange={tools.setShowOverlay}
            />
            <div className={cn("space-y-2", !tools.showOverlay && "pointer-events-none opacity-40")}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Opacity</span>
                <span className="text-metric-accent text-[11px]">
                  {Math.round(tools.overlayOpacity * 100)}%
                </span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[Math.round(tools.overlayOpacity * 100)]}
                onValueChange={(v) => tools.setOverlayOpacity(v[0] / 100)}
                disabled={!tools.showOverlay}
              />
            </div>
            <SettingRow
              label="CFIT accident sites"
              hint="Crash locations from validation data"
              checked={tools.cfitShown}
              onChange={(on) => {
                tools.setCfitShown(on);
                if (on) tools.setView("2d");
              }}
            />
          </div>
        </SettingCard>

        <SettingCard title="3D globe" icon={Globe2}>
          <div className="space-y-3">
            <SettingRow
              label="Disable 3D globe"
              hint="Offline mode — skips CesiumJS and satellite imagery so the app runs as a lighter 2D-only tool when bandwidth is limited."
              checked={tools.disable3D}
              onChange={tools.setDisable3D}
            />
            <div className={cn("space-y-2", tools.disable3D && "pointer-events-none opacity-40")}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">Terrain exaggeration</span>
                <span className="text-metric-accent text-[11px]">{tools.globeExaggeration}×</span>
              </div>
              <Slider
                min={1}
                max={6}
                step={0.5}
                value={[tools.globeExaggeration]}
                onValueChange={(v) => tools.setGlobeExaggeration(v[0])}
                disabled={tools.disable3D}
              />
            </div>
          </div>
        </SettingCard>
      </TabsContent>

      {/* ── Tools ── */}
      <TabsContent value="tools" className="mt-0 space-y-3">
        <p className="text-body-sm text-muted-foreground">
          Choose which safety tools appear in the sidebar rail. Turning one off also clears its map state.
        </p>
        {TOOL_TOGGLES.map(({ key, Icon, label, description }) => (
          <SettingCard key={key} className="!py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary/50">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-body-sm font-medium text-foreground">{label}</div>
                <div className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{description}</div>
              </div>
              <Switch
                checked={toolFlags[key]}
                onChange={(on) => setToolFlag(key, on)}
                aria-label={`Show ${label} in sidebar`}
              />
            </div>
          </SettingCard>
        ))}
      </TabsContent>

      {/* ── Data ── */}
      <TabsContent value="data" className="mt-0 space-y-3">
        {activeRegion && sourceLabel && (
          <SettingCard title="Active region">
            <p className="text-body-sm text-foreground">{sourceLabel}</p>
            {isSynthetic && (
              <p className="mt-1.5 text-[11px] font-medium text-amber-200/90">Demo / synthetic surface</p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="mt-3 w-full"
              onClick={recomputeRegion}
              disabled={activeRegion.source === tools.demSource}
            >
              {activeRegion.source === tools.demSource
                ? "Region already uses selected DEM"
                : "Recompute with selected DEM"}
            </Button>
          </SettingCard>
        )}

        <SettingCard title="DEM for new regions" icon={Layers}>
          <div className="space-y-2">
            {DEM_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => tools.setDemSource(o.value)}
                className={cn(
                  "w-full rounded-md border px-3 py-2.5 text-left transition-colors",
                  tools.demSource === o.value
                    ? "border-foreground/25 bg-foreground/5"
                    : "border-border bg-secondary/20 hover:border-foreground/15",
                )}
              >
                <div className="text-body-sm font-medium text-foreground">{o.label}</div>
                <div className="text-[11px] text-muted-foreground">{o.hint}</div>
              </button>
            ))}
          </div>
        </SettingCard>

        {!activeRegion && (
          <p className="text-body-sm text-muted-foreground">
            Select a region on the map to see the active DEM and recompute options.
          </p>
        )}
      </TabsContent>

      {/* ── Formula ── */}
      <TabsContent value="formula" className="mt-0 space-y-3">
        <SettingCard title="TTCI composite">
          <p className="text-body-sm mb-3 text-muted-foreground">
            Four terrain metrics normalized to [0, 1] via 2nd–98th percentile clipping, then combined:
          </p>
          <div className="space-y-2">
            {TTCI_METRICS.map(({ label, weight, method, desc }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-secondary/20 px-2.5 py-2"
              >
                <span className="text-metric w-14 shrink-0 text-[11px]">{label}</span>
                <span className="text-metric-accent w-9 shrink-0 text-[11px]">{weight}</span>
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  {desc}
                  <span className="text-subtle"> · {method}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Risk bands: Very Low · Low · Moderate · High · Critical — spanning [0, 1] contiguously.
          </p>
        </SettingCard>
      </TabsContent>
    </Tabs>
  );
}

function SettingCard({
  title,
  icon: Icon,
  children,
  className,
}: {
  title?: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-secondary/30 p-3.5 shadow-sm", className)}>
      {title && (
        <div className="mb-3 flex items-center gap-2">
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

function SettingRow({
  label, hint, checked, onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2.5">
      <div className="min-w-0 flex-1 pr-1">
        <div className="text-body-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] leading-snug text-muted-foreground">{hint}</div>
      </div>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </div>
  );
}

function Switch({
  checked, onChange, "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center overflow-hidden rounded-full border-0 p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-foreground" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-background shadow-sm transition-[left] duration-200",
          checked ? "left-[calc(100%-1rem-2px)]" : "left-0.5",
        )}
      />
    </button>
  );
}
