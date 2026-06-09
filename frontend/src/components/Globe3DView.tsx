import { useEffect, useRef, useState } from "react";
import { Globe3DController, preloadCesium } from "@/lib/globe3d";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Globe3DView() {
  const { activeRegion, status } = useTtci();
  const {
    view, setView, toggleDrawArea, registerGlobeViewGetter, consumeGlobeFocus,
    routeWaypoints, msaSectors,
    flyPosition,
    aircraft, tawsResult,
    globeExaggeration,
    cfitShown, showOverlay, overlayOpacity,
    sidebarOpen,
  } = useTools();

  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<Globe3DController | null>(null);
  const [hint, setHint] = useState<string | null>("Loading 3D globe…");
  const [ctrlReady, setCtrlReady] = useState(false);
  const [tracking, setTracking] = useState(false);
  const prevFlyActiveRef = useRef(false);
  const lastRegionKeyRef = useRef<string | null>(null);

  useEffect(() => { preloadCesium(); }, []);

  useEffect(() => {
    if (!ctrlReady || view !== "3d") return;
    ctrlRef.current?.resize();
    const afterSidebar = window.setTimeout(() => ctrlRef.current?.resize(), 240);
    return () => clearTimeout(afterSidebar);
  }, [ctrlReady, view, sidebarOpen]);

  // Create the globe on first 3D visit; keep it alive when switching back to 2D so
  // terrain + TTCI drape are not torn down and skipped on re-entry.
  useEffect(() => {
    if (view !== "3d" || !containerRef.current) return;

    if (ctrlRef.current) {
      requestAnimationFrame(() => {
        const ctrl = ctrlRef.current;
        if (!ctrl) return;
        ctrl.resize();
        if (ctrlReady) {
          ctrl.animateEnterView(consumeGlobeFocus());
        }
      });
      return;
    }

    setCtrlReady(false);
    const ctrl = new Globe3DController(containerRef.current);
    ctrl.onHint = setHint;
    ctrlRef.current = ctrl;
    ctrl.open(null)
      .then(() => {
        setCtrlReady(true);
        requestAnimationFrame(() => {
          ctrl.resize();
          if (!activeRegion) ctrl.animateEnterView(consumeGlobeFocus());
        });
      })
      .catch((e) => setHint(String(e?.message || e)));
  }, [view, ctrlReady, consumeGlobeFocus, activeRegion]);

  useEffect(() => {
    return () => {
      lastRegionKeyRef.current = null;
      ctrlRef.current?.destroy();
      ctrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    registerGlobeViewGetter(() => ctrlRef.current?.viewPose() ?? null);
    return () => registerGlobeViewGetter(null);
  }, [registerGlobeViewGetter, ctrlReady]);

  useEffect(() => {
    if (!ctrlReady || !ctrlRef.current || !activeRegion) return;
    const key = `${activeRegion.south},${activeRegion.north},${activeRegion.west},${activeRegion.east},${activeRegion.zoom},${activeRegion.source}`;
    if (lastRegionKeyRef.current === key) return;
    lastRegionKeyRef.current = key;
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
      { flyCamera: msaSectors.length > 0 },
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
      ctrlRef.current.setTracking(true);
      setTracking(true);
    } else if (!nowActive && prevFlyActiveRef.current && tracking) {
      ctrlRef.current.setTracking(false);
      setTracking(false);
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

  const toggleTrack = () => {
    const next = ctrlRef.current?.toggleTrackAircraft();
    if (next !== undefined) setTracking(next);
  };

  const reposition = () => {
    ctrlRef.current?.repositionView();
    setTracking(false);
  };

  const flyActive = flyPosition !== null;

  return (
    <div
      className={cn(
        "absolute inset-0 z-[600] overflow-hidden bg-black",
        view === "3d" ? "tg-globe-enter pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div ref={containerRef} className="tg-cesium-host absolute inset-0" />

      {hint && (
        <div className="absolute left-1/2 top-4 z-[650] flex -translate-x-1/2 items-center gap-2 panel-float px-4 py-2.5 text-sm text-muted-foreground">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          {hint}
        </div>
      )}

      {!activeRegion && status !== "computing" && (
        <div className="absolute inset-0 z-[640] flex items-center justify-center bg-black/45 backdrop-blur-sm">
          <div className="w-[min(420px,calc(100%-48px))] panel p-6 text-center">
            <h2 className="mb-2 text-lg font-semibold text-foreground">No terrain assessed yet</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Explore the globe freely. To run TTCI analysis, switch to the 2D map and use{" "}
              <strong>Select area</strong> to draw a region.
            </p>
            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
              <Button size="sm" onClick={toggleDrawArea}>
                Select area on map
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setView("2d")}>
                Open 2D map
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-7 right-3 z-[650] flex items-center gap-2">
        <button
          type="button"
          onClick={reposition}
          title="Reset orientation — north up, level horizon"
          className="flex items-center gap-1.5 rounded border border-border bg-card/90 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground shadow backdrop-blur transition-colors hover:border-foreground/25 hover:text-foreground"
        >
          <Compass className="h-3.5 w-3.5" />
          Reposition
        </button>
        {activeRegion && (
          <button
            type="button"
            onClick={() => {
              ctrlRef.current?.resetView();
              setTracking(false);
            }}
            title="Frame the assessed terrain region"
            className="rounded border border-border bg-card/90 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground shadow backdrop-blur transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            Fit region
          </button>
        )}
        <button
          type="button"
          onClick={() => setView("2d")}
          className="rounded border border-border bg-card/90 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground shadow backdrop-blur transition-colors hover:border-foreground/25 hover:text-foreground"
        >
          2D Map
        </button>
      </div>

      {flyActive && (
        <div className="absolute bottom-4 left-1/2 z-[650] flex -translate-x-1/2 items-center gap-3 panel-float px-4 py-2.5">
          <Button
            size="sm"
            variant={tracking ? "default" : "outline"}
            onClick={toggleTrack}
            className={tracking ? "animate-pulse" : ""}
          >
            {tracking ? "Tracking" : "Track aircraft"}
          </Button>
        </div>
      )}
    </div>
  );
}
