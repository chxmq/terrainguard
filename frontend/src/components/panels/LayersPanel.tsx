import { Slider } from "@/components/ui/slider";
import { useTools } from "@/state/tools";

export function LayersPanel() {
  const { overlayOpacity, setOverlayOpacity, showOverlay, setShowOverlay } = useTools();

  return (
    <div className="space-y-6">

      {/* ── Map Layers ── */}
      <section>
        <SectionHead>Map Layers</SectionHead>
        <div className="space-y-4">
          <label className="flex items-center justify-between">
            <span className="text-sm text-foreground">TTCI Risk Overlay</span>
            <input
              type="checkbox"
              checked={showOverlay}
              onChange={(e) => setShowOverlay(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
          </label>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Overlay Opacity
              </span>
              <span className="font-mono text-[11px] font-semibold text-primary">
                {Math.round(overlayOpacity * 100)}%
              </span>
            </div>
            <Slider
              min={0} max={100} step={1}
              value={[Math.round(overlayOpacity * 100)]}
              onValueChange={(v) => setOverlayOpacity(v[0] / 100)}
            />
          </div>
        </div>
      </section>

      {/* ── TTCI Formula ── */}
      <section className="border-t border-border pt-5">
        <SectionHead>TTCI Formula</SectionHead>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Weighted sum of four normalized terrain metrics, each scaled to [0, 1].
        </p>
        <div className="space-y-2.5">
          {[
            { label: "Slope",        weight: "30%", desc: "Steepness of terrain" },
            { label: "TRI",          weight: "30%", desc: "Terrain Ruggedness Index" },
            { label: "Curvature",    weight: "20%", desc: "Rate of slope change" },
            { label: "Elevation σ",  weight: "20%", desc: "Local elevation variation" },
          ].map(({ label, weight, desc }) => (
            <div key={label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 font-mono text-xs font-semibold text-foreground">
                {label}
              </span>
              <span className="w-8 shrink-0 font-mono text-xs font-bold text-primary">
                {weight}
              </span>
              <span className="text-[11px] text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Higher TTCI = more complex terrain and elevated CFIT risk.
        </p>
      </section>
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {children}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
