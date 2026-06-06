import { Slider } from "@/components/ui/slider";
import { useTools } from "@/state/tools";

export function LayersPanel() {
  const { overlayOpacity, setOverlayOpacity, showOverlay, setShowOverlay } = useTools();
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-3 text-[13px] font-bold">Map Layers</h3>
        <label className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">TTCI Risk Overlay</span>
          <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} className="h-4 w-4 accent-primary" />
        </label>
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Overlay Opacity</span>
            <span className="font-mono text-primary">{Math.round(overlayOpacity * 100)}%</span>
          </div>
          <Slider min={0} max={100} step={1} value={[Math.round(overlayOpacity * 100)]} onValueChange={(v) => setOverlayOpacity(v[0] / 100)} />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-bold">About TTCI</h3>
        <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          <p>The Terrain Topography Complexity Index fuses four terrain metrics into one normalized risk score:</p>
          <ul className="space-y-1">
            <li>▸ <strong className="text-foreground/80">Slope</strong> (30%) — steepness</li>
            <li>▸ <strong className="text-foreground/80">TRI</strong> (30%) — ruggedness</li>
            <li>▸ <strong className="text-foreground/80">Curvature</strong> (20%) — slope change</li>
            <li>▸ <strong className="text-foreground/80">Elevation σ</strong> (20%) — local variation</li>
          </ul>
          <p>Higher TTCI = more complex terrain and elevated CFIT risk.</p>
        </div>
      </section>
    </div>
  );
}
