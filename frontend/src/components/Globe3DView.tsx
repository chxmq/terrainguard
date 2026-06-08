import { useEffect, useRef, useState } from "react";
import { Globe3DController, preloadCesium } from "@/lib/globe3d";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";

const MAX_REGION_SPAN_DEG = 12;

export function Globe3DView() {
  const { activeRegion, status, activate } = useTtci();
  const {
    view, setView,
    routeWaypoints, msaSectors,
    flyPosition,
    aircraft, tawsResult,
    demSource, globeExaggeration,
    cfitShown, showOverlay, overlayOpacity,
  } = useTools();

  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<Globe3DController | null>(null);
  const [hint, setHint] = useState<string | null>("Loading 3D globe…");
  const [ctrlReady, setCtrlReady] = useState(false);
  const [tracking, setTracking] = useState(false);
  const prevFlyActiveRef = useRef(false);

  useEffect(() => { preloadCesium(); }, []);

  useEffect(() => {
    if (view !== "3d" || ctrlRef.current || !containerRef.current) return;
    setCtrlReady(false);
    const ctrl = new Globe3DController(containerRef.current);
    ctrl.onHint = setHint;
    ctrlRef.current = ctrl;
    ctrl.open(null)
      .then(() => setCtrlReady(true))
      .catch((e) => setHint(String(e?.message || e)));
    return () => { ctrl.destroy(); ctrlRef.current = null; setCtrlReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current || !activeRegion) return;
    ctrlRef.current.loadRegion({ ...activeRegion });
  }, [ctrlReady, activeRegion]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current) return;
    ctrlRef.current.setExaggeration(globeExaggeration);
  }, [ctrlReady, globeExaggeration]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current) return;
    ctrlRef.current.setOverlaySettings(showOverlay, overlayOpacity);
  }, [ctrlReady, showOverlay, overlayOpacity]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current) return;
    ctrlRef.current.setCFITVisible(cfitShown).catch(() => { /* optional layer */ });
  }, [ctrlReady, cfitShown]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current) return;
    ctrlRef.current.updateRoute(
      routeWaypoints.map(([lat, lon]) => ({ lat, lon })),
      msaSectors.map((s) => ({ sector: s.sector, msa_ft: s.msa_ft, ttci: s.ttci?.mean ?? null })),
    );
  }, [ctrlReady, routeWaypoints, msaSectors]);

  useEffect(() => {
    if (!ctrlRef.current) return;
    ctrlRef.current.updateFlyAircraft(
      flyPosition
        ? { lat: flyPosition.lat, lon: flyPosition.lon, clearance_ft: flyPosition.clearance_ft, heading_deg: flyPosition.heading_deg }
        : null,
    );
  }, [flyPosition]);

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
    const half = Math.min(0.35, MAX_REGION_SPAN_DEG / 2 - 0.01);
    const clampLat = (v: number) => Math.max(-89.5, Math.min(89.5, v));
    const clampLon = (v: number) => Math.max(-179.5, Math.min(179.5, v));
    activate(
      {
        south: +clampLat(c.lat - half).toFixed(4), north: +clampLat(c.lat + half).toFixed(4),
        west: +clampLon(c.lon - half).toFixed(4), east: +clampLon(c.lon + half).toFixed(4),
      },
      activeRegion?.source ?? demSource,
    ).catch(() => { /* surfaced via toast in context */ });
  };

  const toggleTrack = () => {
    const next = ctrlRef.current?.toggleTrackAircraft();
    if (next !== undefined) setTracking(next);
  };

  const flyActive = flyPosition !== null;

  return (
    <div className={view === "3d" ? "absolute inset-0 z-[600] bg-black" : "hidden"}>
      <div ref={containerRef} className="h-full w-full" />

      {hint && (
        <div className="absolute left-1/2 top-4 z-[650] flex -translate-x-1/2 items-center gap-2 panel-float px-4 py-2.5 text-sm text-muted-foreground">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          {hint}
        </div>
      )}

      {!activeRegion && status !== "computing" && (
        <div className="absolute inset-0 z-[640] flex items-center justify-center bg-black/45 backdrop-blur-sm">
          <div className="w-[min(420px,calc(100%-48px))] panel p-6 text-center">
            <h2 className="mb-2 text-lg font-semibold text-foreground">Select terrain to assess</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Switch to the 2D map to draw an area, or use <strong>Compute terrain here</strong> once
              you have navigated to a region of interest.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setView("2d")}>
              Open 2D map
            </Button>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 z-[650] flex -translate-x-1/2 items-center gap-3 panel-float px-4 py-2.5">
        <Button variant="secondary" size="sm" onClick={computeHere}>
          Compute terrain here
        </Button>

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
      </div>
    </div>
  );
}
