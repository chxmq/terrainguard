import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Play, Square, Maximize2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { MsaSector, ProfilePoint } from "@/lib/api";
import { useTtci, riskColor } from "@/state/ttci";
import { useTools, type FlyPosition } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { MsaProfileChart } from "@/components/charts";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

function buildFlyPosition(
  pt: ProfilePoint,
  profile: ProfilePoint[],
  sectors: MsaSector[],
  idx: number,
): FlyPosition {
  const total = profile[profile.length - 1]?.distance_km || 1;

  let cum = 0;
  let sector: MsaSector | null = null;
  for (const s of sectors) {
    cum += s.distance_km;
    sector = s;
    if (pt.distance_km <= cum + 0.001) break;
  }

  const msa_ft = sector?.msa_ft ?? 0;
  const msa_m  = sector?.msa_m  ?? 0;
  const clearance_ft = msa_ft - pt.elevation_m / 0.3048;

  const next = profile[Math.min(idx + 1, profile.length - 1)];
  const heading_deg = Math.atan2(next.lon - pt.lon, next.lat - pt.lat) * (180 / Math.PI);

  return {
    lat: pt.lat, lon: pt.lon,
    elevation_m: pt.elevation_m,
    distance_km: pt.distance_km,
    totalDistance_km: total,
    msa_ft, msa_m, clearance_ft,
    sectorLabel: `S${sector?.sector ?? 1}`,
    progressPct: (pt.distance_km / total) * 100,
    ttci: sector?.ttci?.mean ?? null,
    heading_deg,
  };
}

export function MsaPanel() {
  const { activeRegion, riskLevels, toast } = useTtci();
  const {
    mode, setMode, view, setView,
    routeWaypoints, setRouteWaypoints,
    msaSectors, setMsaSectors,
    msaProfile, setMsaProfile,
    flyPosition, setFlyPosition,
  } = useTools();

  const [busy, setBusy] = useState(false);
  const [flyRunning, setFlyRunning] = useState(false);
  const [chartExpanded, setChartExpanded] = useState(false);
  const flyRef = useRef<number | null>(null);

  const drawing = mode === "draw-route";
  const canCalc = routeWaypoints.length >= 2 && !busy;
  const canFly  = msaProfile.length >= 2 && !busy;

  const stopFly = () => {
    if (flyRef.current !== null) { clearInterval(flyRef.current); flyRef.current = null; }
    setFlyRunning(false);
    setFlyPosition(null);
  };
  useEffect(() => () => stopFly(), []);

  const startFly = () => {
    if (msaProfile.length < 2) return;
    stopFly();
    if (view !== "3d") setView("3d");
    setFlyRunning(true);
    let idx = 0;
    const tick = () => {
      if (idx >= msaProfile.length) { stopFly(); return; }
      setFlyPosition(buildFlyPosition(msaProfile[idx], msaProfile, msaSectors, idx));
      idx++;
    };
    tick();
    flyRef.current = window.setInterval(tick, 110);
  };

  const clear = () => {
    stopFly();
    setRouteWaypoints([]);
    setMsaSectors([]);
    setMsaProfile([]);
    if (drawing) setMode("idle");
  };

  const calculate = async () => {
    if (routeWaypoints.length < 2) return;
    setBusy(true);
    try {
      const wp = routeWaypoints.map(([la, lo]) => [la, lo]);
      const [m, p] = await Promise.all([api.msaCalculate(wp), api.msaProfile(wp)]);
      setMsaSectors(m.sectors);
      setMsaProfile(p.profile);
      if (view !== "3d") setView("3d");
    } catch (err) {
      toast((err as Error).message || "MSA calculation failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const expandedPortal = chartExpanded && msaProfile.length > 0
    ? createPortal(
        <div className="fixed inset-0 z-[950] flex flex-col bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">Elevation Profile</h2>
              <p className="text-[11px] text-muted-foreground">
                Terrain · Min Safe Altitude band · Aircraft position
              </p>
            </div>
            <button
              onClick={() => setChartExpanded(false)}
              className="rounded border border-border p-1.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <MsaProfileChart
              profile={msaProfile} sectors={msaSectors}
              flyDistKm={flyPosition?.distance_km}
              className="h-full"
            />
          </div>
          {flyRunning && (
            <div className="mt-4 flex justify-center">
              <Button size="sm" variant="outline" onClick={stopFly}>
                <Square className="h-3.5 w-3.5" /> Stop Simulation
              </Button>
            </div>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="space-y-5">
      {expandedPortal}

      {!activeRegion && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Select a terrain area on the map first.
        </p>
      )}

      <section>
        <SectionHead>1. Draw your route</SectionHead>
        <p className="mb-3 text-sm text-muted-foreground">
          Click waypoints on the map, then double-click to finish. Each leg gets a minimum safe altitude.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={drawing ? "secondary" : "default"}
            disabled={!activeRegion}
            onClick={() => setMode(drawing ? "idle" : "draw-route")}
          >
            <Pencil className="h-3.5 w-3.5" />
            {drawing ? "Drawing…" : "Draw route"}
          </Button>
          <Button size="sm" variant="outline" onClick={clear}>Clear</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {routeWaypoints.length === 0
            ? "No waypoints yet"
            : `${routeWaypoints.length} waypoint${routeWaypoints.length === 1 ? "" : "s"} placed`}
        </p>
      </section>

      <section>
        <SectionHead>2. Calculate safe altitudes</SectionHead>
        <Button size="sm" className="w-full" disabled={!canCalc} onClick={calculate}>
          {busy ? "Calculating…" : "Calculate minimum safe altitude"}
        </Button>
      </section>

      {/* ── Fly Simulation ── */}
      {msaProfile.length > 0 && (
        <section>
          <SectionHead>3. Fly the route</SectionHead>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={flyRunning ? "secondary" : "default"}
              disabled={!canFly}
              onClick={flyRunning ? stopFly : startFly}
            >
              {flyRunning
                ? <><Square className="h-3.5 w-3.5" /> Stop Flight</>
                : <><Play  className="h-3.5 w-3.5" /> Fly Route</>}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setChartExpanded(true)}>
              <Maximize2 className="h-3.5 w-3.5" /> Expand Chart
            </Button>
          </div>
        </section>
      )}

      {/* ── MSA Sectors ── */}
      {msaSectors.length > 0 && (
        <section>
          <SectionHead>Results by leg</SectionHead>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                <th className="pb-2 text-left font-medium">Sec</th>
                <th className="pb-2 text-left font-medium">Distance</th>
                <th className="pb-2 text-left font-medium">Min Safe Alt</th>
                <th className="pb-2 text-left font-medium">TTCI</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {msaSectors.map((s) => (
                <tr
                  key={s.sector}
                  className={cn(
                    "border-b border-border/50 transition-colors",
                    flyPosition?.sectorLabel === `S${s.sector}` ? "bg-primary/8" : "",
                  )}
                >
                  <td className="py-2">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                      S{s.sector}
                    </span>
                  </td>
                  <td className="py-2 text-muted-foreground">{fmt(s.distance_nm, 1)} NM</td>
                  <td className="py-2 font-semibold text-primary">{fmtInt(s.msa_ft)} ft</td>
                  <td
                    className="py-2 font-semibold"
                    style={{ color: s.ttci ? riskColor(riskLevels, s.ttci.mean) : undefined }}
                  >
                    {s.ttci ? fmt(s.ttci.mean, 3) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Elevation Profile ── */}
      {msaProfile.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionHead>Elevation Profile</SectionHead>
            <button
              onClick={() => setChartExpanded(true)}
              className="-mt-3 text-[10px] text-muted-foreground hover:text-primary"
            >
              expand ↗
            </button>
          </div>
          <MsaProfileChart
            profile={msaProfile}
            sectors={msaSectors}
            flyDistKm={flyPosition?.distance_km}
          />
        </section>
      )}
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-foreground">{children}</h3>;
}
