import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { cn } from "@/lib/utils";

const DEM_OPTIONS = [
  { value: "tiles", label: "SRTM 30 m", hint: "AWS Terrain Tiles — fast, global" },
  { value: "copernicus", label: "Copernicus GLO-30", hint: "ESA 30 m — higher quality" },
  { value: "opentopo", label: "OpenTopo", hint: "Requires API key on server" },
] as const;

export function SettingsPanel() {
  const { activeRegion, sourceLabel, isSynthetic, activate, toast } = useTtci();
  const {
    view, setView,
    showOverlay, setShowOverlay,
    overlayOpacity, setOverlayOpacity,
    cfitShown, setCfitShown,
    demSource, setDemSource,
    globeExaggeration, setGlobeExaggeration,
  } = useTools();

  const recomputeRegion = async () => {
    if (!activeRegion) return;
    const { south, north, west, east } = activeRegion;
    try {
      await activate({ south, north, west, east }, demSource, { silent: true });
      toast("Region recomputed with the selected DEM.", "success");
    } catch {
      /* surfaced via context */
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Map view ── */}
      <section>
        <SectionHead>Map view</SectionHead>
        <div className="flex gap-1 rounded-lg border border-border bg-secondary/40 p-1">
          {(["2d", "3d"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "flex-1 rounded-md py-2 text-[12px] font-medium transition-colors",
                view === v
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "2d" ? "2D Map" : "3D Globe"}
            </button>
          ))}
        </div>
      </section>

      {/* ── Layers ── */}
      <section className="border-t border-border pt-5">
        <SectionHead>Map layers</SectionHead>
        <div className="space-y-4">
          <ToggleRow
            label="TTCI risk overlay"
            description="Color-coded terrain complexity on the map"
            checked={showOverlay}
            onChange={setShowOverlay}
          />
          <div className={cn(!showOverlay && "pointer-events-none opacity-40")}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-label mb-0">Overlay opacity</span>
              <span className="text-metric-accent">{Math.round(overlayOpacity * 100)}%</span>
            </div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[Math.round(overlayOpacity * 100)]}
              onValueChange={(v) => setOverlayOpacity(v[0] / 100)}
              disabled={!showOverlay}
            />
          </div>
          <ToggleRow
            label="CFIT accident sites"
            description="Historical crash locations from validation data"
            checked={cfitShown}
            onChange={(on) => {
              setCfitShown(on);
              if (on) setView("2d");
            }}
          />
        </div>
      </section>

      {/* ── Terrain data ── */}
      <section className="border-t border-border pt-5">
        <SectionHead>Terrain data</SectionHead>
        <div className="space-y-3">
          {activeRegion && sourceLabel && (
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
              <div className="text-label mb-0.5">Active region</div>
              <div className="text-body-sm text-foreground">{sourceLabel}</div>
              {isSynthetic && (
                <div className="mt-1 text-[11px] text-amber-200/80">Demo / synthetic surface</div>
              )}
            </div>
          )}
          <div>
            <label htmlFor="dem-source" className="text-label mb-1.5 block">
              DEM for new regions
            </label>
            <select
              id="dem-source"
              value={demSource}
              onChange={(e) => setDemSource(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-body-sm text-foreground"
            >
              {DEM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="text-body-sm mt-1.5">
              {DEM_OPTIONS.find((o) => o.value === demSource)?.hint}
            </p>
          </div>
          {activeRegion && (
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={recomputeRegion}
              disabled={activeRegion.source === demSource}
            >
              {activeRegion.source === demSource
                ? "Current region uses this DEM"
                : "Recompute region with selected DEM"}
            </Button>
          )}
        </div>
      </section>

      {/* ── 3D globe ── */}
      <section className="border-t border-border pt-5">
        <SectionHead>3D globe</SectionHead>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-label mb-0">Terrain exaggeration</span>
            <span className="text-metric-accent">{globeExaggeration}×</span>
          </div>
          <Slider
            min={1}
            max={6}
            step={0.5}
            value={[globeExaggeration]}
            onValueChange={(v) => setGlobeExaggeration(v[0])}
          />
          <p className="text-body-sm">
            Vertical scale for relief in the 3D view. Higher values make peaks more visible.
          </p>
        </div>
      </section>

      {/* ── TTCI reference ── */}
      <section className="border-t border-border pt-5">
        <SectionHead>TTCI formula</SectionHead>
        <p className="text-body-sm mb-3">
          Weighted sum of four normalized terrain metrics, each scaled to [0, 1].
        </p>
        <div className="space-y-2">
          {[
            { label: "Slope", weight: "30%", desc: "Steepness of terrain" },
            { label: "TRI", weight: "30%", desc: "Terrain Ruggedness Index" },
            { label: "Curvature", weight: "20%", desc: "Rate of slope change" },
            { label: "Elevation σ", weight: "20%", desc: "Local elevation variation" },
          ].map(({ label, weight, desc }) => (
            <div key={label} className="flex items-center gap-3 text-body-sm">
              <span className="text-metric w-16 shrink-0">{label}</span>
              <span className="text-metric-accent w-8 shrink-0">{weight}</span>
              <span className="text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="text-section shrink-0">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ToggleRow({
  label, description, checked, onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <div>
        <div className="text-body-sm font-medium text-foreground">{label}</div>
        <div className="text-body-sm mt-0.5 text-muted-foreground">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
      />
    </label>
  );
}
