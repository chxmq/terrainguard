import { useEffect, useRef, useState } from "react";
import { Globe3DController, type Region } from "@/lib/globe3d";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

export function Globe3DView() {
  const { activeRegion, toast } = useTtci();
  const { view } = useTools();
  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<Globe3DController | null>(null);
  const [hint, setHint] = useState<string | null>("Loading 3D globe…");
  const [exag, setExag] = useState(3);

  // Initialise Cesium the first time the 3D view becomes visible.
  useEffect(() => {
    if (view !== "3d" || ctrlRef.current || !containerRef.current) return;
    const ctrl = new Globe3DController(containerRef.current);
    ctrl.onHint = setHint;
    ctrlRef.current = ctrl;
    const region: Region | null = activeRegion
      ? { ...activeRegion }
      : null;
    ctrl.open(region).catch((e) => setHint(String(e?.message || e)));
    return () => { ctrl.destroy(); ctrlRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const computeHere = () => {
    const c = ctrlRef.current?.viewCenter();
    if (!c) return;
    const region: Region = {
      south: +(c.lat - 0.35).toFixed(4), north: +(c.lat + 0.35).toFixed(4),
      west: +(c.lon - 0.35).toFixed(4), east: +(c.lon + 0.35).toFixed(4), zoom: 11,
    };
    ctrlRef.current?.loadRegion(region);
  };
  const toggleCfit = async () => {
    const r = await ctrlRef.current?.toggleCFIT();
    if (r === "empty") toast("Run validate_ttci.py to enable CFIT sites.", "info");
  };

  return (
    <div className={view === "3d" ? "absolute inset-0 z-[600] bg-black" : "hidden"}>
      <div ref={containerRef} className="h-full w-full" />
      {hint && (
        <div className="absolute left-1/2 top-4 z-[650] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground shadow-lg">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          {hint}
        </div>
      )}
      <div className="absolute bottom-4 left-1/2 z-[650] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card/90 px-4 py-2.5 shadow-lg backdrop-blur">
        <Button variant="secondary" size="sm" onClick={computeHere}>Compute terrain here</Button>
        <Button variant="secondary" size="sm" onClick={toggleCfit}>CFIT sites</Button>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Exaggeration</span>
          <Slider
            className="w-24"
            min={1} max={6} step={0.5} value={[exag]}
            onValueChange={(v) => { setExag(v[0]); ctrlRef.current?.setExaggeration(v[0]); }}
          />
        </div>
      </div>
    </div>
  );
}
