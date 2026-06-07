import { useEffect, useRef, useState } from "react";
import { Globe3DController, preloadCesium, type Region } from "@/lib/globe3d";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

export function Globe3DView() {
  const { activeRegion, toast } = useTtci();
  const {
    view,
    routeWaypoints, msaSectors,
    flyPosition,
    aircraft, tawsResult,
  } = useTools();

  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<Globe3DController | null>(null);
  const [hint, setHint] = useState<string | null>("Loading 3D globe…");
  const [exag, setExag] = useState(3);
  const [ctrlReady, setCtrlReady] = useState(false);
  const [tracking, setTracking] = useState(false);
  const prevFlyActiveRef = useRef(false);

  // Eagerly load CesiumJS from CDN on mount so it's ready when the user switches to 3D.
  useEffect(() => { preloadCesium(); }, []);

  // Initialise Cesium the first time the 3D view becomes visible.
  useEffect(() => {
    if (view !== "3d" || ctrlRef.current || !containerRef.current) return;
    setCtrlReady(false);
    const ctrl = new Globe3DController(containerRef.current);
    ctrl.onHint = setHint;
    ctrlRef.current = ctrl;
    const region: Region | null = activeRegion ? { ...activeRegion } : null;
    ctrl.open(region)
      .then(() => setCtrlReady(true))
      .catch((e) => setHint(String(e?.message || e)));
    return () => { ctrl.destroy(); ctrlRef.current = null; setCtrlReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Sync flight route to 3D whenever it changes or controller becomes ready.
  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current) return;
    ctrlRef.current.updateRoute(
      routeWaypoints.map(([lat, lon]) => ({ lat, lon })),
      msaSectors.map((s) => ({ sector: s.sector, msa_ft: s.msa_ft, ttci: s.ttci?.mean ?? null })),
    );
  }, [ctrlReady, routeWaypoints, msaSectors]);

  // Sync animated fly aircraft position to 3D (runs even before ctrlReady so
  // the mid-animation switch from 2D → 3D picks up immediately when ready).
  useEffect(() => {
    if (!ctrlRef.current) return;
    ctrlRef.current.updateFlyAircraft(
      flyPosition
        ? { lat: flyPosition.lat, lon: flyPosition.lon, clearance_ft: flyPosition.clearance_ft }
        : null,
    );
  }, [flyPosition]);

  // Auto-enable tracking when flight starts; disable when it stops.
  useEffect(() => {
    const nowActive = flyPosition !== null;
    if (!ctrlRef.current || !ctrlReady) {
      prevFlyActiveRef.current = nowActive;
      return;
    }
    if (nowActive && !prevFlyActiveRef.current && !tracking) {
      const next = ctrlRef.current.toggleTrackAircraft();
      if (next !== undefined) setTracking(next);
    } else if (!nowActive && prevFlyActiveRef.current && tracking) {
      const next = ctrlRef.current.toggleTrackAircraft();
      if (next !== undefined) setTracking(next);
    }
    prevFlyActiveRef.current = nowActive;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyPosition, ctrlReady]);

  // Sync TAWS look-ahead path to 3D.
  useEffect(() => {
    if (!ctrlRef.current) return;
    ctrlRef.current.updateTawsPath(
      aircraft ?? null,
      tawsResult?.profile.map((p) => ({ lat: p.lat, lon: p.lon, clearance_ft: p.clearance_ft })) ?? [],
    );
  }, [aircraft, tawsResult]);

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

  const toggleTrack = () => {
    const next = ctrlRef.current?.toggleTrackAircraft();
    if (next !== undefined) setTracking(next);
  };

  const flyActive = flyPosition !== null;

  return (
    <div className={view === "3d" ? "absolute inset-0 z-[600] bg-black" : "hidden"}>
      <div ref={containerRef} className="h-full w-full" />

      {/* Loading hint */}
      {hint && (
        <div className="absolute left-1/2 top-4 z-[650] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground shadow-lg">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          {hint}
        </div>
      )}

      {/* Bottom control bar */}
      <div className="absolute bottom-4 left-1/2 z-[650] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card/90 px-4 py-2.5 shadow-lg backdrop-blur">
        <Button variant="secondary" size="sm" onClick={computeHere}>
          Compute terrain here
        </Button>
        <Button variant="secondary" size="sm" onClick={toggleCfit}>
          CFIT sites
        </Button>

        {/* Track aircraft button — only shown when fly animation is active */}
        {flyActive && (
          <Button
            size="sm"
            variant={tracking ? "default" : "outline"}
            onClick={toggleTrack}
            className={tracking ? "animate-pulse" : ""}
          >
            {tracking ? "✈ Tracking" : "✈ Track aircraft"}
          </Button>
        )}

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Exaggeration</span>
          <Slider
            className="w-24"
            min={1} max={6} step={0.5} value={[exag]}
            onValueChange={(v) => { setExag(v[0]); ctrlRef.current?.setExaggeration(v[0]); }}
          />
          <span className={cn("font-mono text-[10px]", exag >= 4 ? "text-risk-moderate" : "text-primary")}>
            {exag}×
          </span>
        </div>
      </div>
    </div>
  );
}
