import { useEffect, useRef } from "react";
import { Crosshair, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools, type TawsParams } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TawsProfileChart } from "@/components/charts";
import { cn, fmt, fmtInt, destinationPoint } from "@/lib/utils";

const BANNER: Record<string, string> = {
  CLEAR: "border-risk-vlow/40 bg-risk-vlow/10 text-risk-vlow",
  CAUTION: "border-risk-moderate/50 bg-risk-moderate/10 text-risk-moderate",
  WARNING: "border-risk-high/60 bg-risk-high/15 text-risk-high",
};

export function TawsPanel() {
  const { activeRegion, toast } = useTtci();
  const { mode, setMode, aircraft, setAircraft, tawsParams, setTawsParams, tawsResult, setTawsResult } = useTools();
  const simRef = useRef<number | null>(null);

  const run = async (ac = aircraft, params = tawsParams) => {
    if (!ac) return;
    try {
      setTawsResult(await api.tawsLookahead({ lat: ac.lat, lon: ac.lon, ...params }));
    } catch (err) {
      toast((err as Error).message || "Look-ahead failed.", "error");
      stopSim();
    }
  };

  // Re-run whenever the aircraft or parameters change (and not simulating).
  useEffect(() => {
    if (aircraft && simRef.current === null) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraft, tawsParams]);

  const stopSim = () => { if (simRef.current !== null) { clearInterval(simRef.current); simRef.current = null; } };
  useEffect(() => () => stopSim(), []);

  const toggleSim = () => {
    if (simRef.current !== null) { stopSim(); return; }
    if (!aircraft) return;
    let steps = 0;
    simRef.current = window.setInterval(async () => {
      steps++;
      const [lat, lon] = destinationPoint(aircraft.lat, aircraft.lon, tawsParams.heading_deg, 0.4 * 1.852);
      const next = { lat, lon };
      setAircraft(next);
      await run(next, tawsParams);
      if (steps >= 60) stopSim();
    }, 650);
  };

  const update = (patch: Partial<TawsParams>) => setTawsParams({ ...tawsParams, ...patch });
  const level = tawsResult?.alert_level ?? "CLEAR";

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        EGPWS-style forward terrain scan. Set the aircraft state, place it on the map, and the look-ahead horizon expands in complex (high-TTCI) terrain.
        {!activeRegion && " Select an area first."}
      </p>

      <div className={cn("rounded-lg border p-3 text-center", BANNER[level], level === "WARNING" && "animate-pulse")}>
        <div className="font-mono text-lg font-extrabold">{tawsResult ? level : "NO DATA"}</div>
        <div className="text-[11px] font-semibold opacity-90">{tawsResult ? tawsResult.callout : "Place an aircraft to begin"}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Altitude (ft)"><Input type="number" step={500} value={tawsParams.altitude_ft} onChange={(e) => update({ altitude_ft: Number(e.target.value) })} /></Field>
        <Field label="Heading (°)"><Input type="number" step={5} value={tawsParams.heading_deg} onChange={(e) => update({ heading_deg: Number(e.target.value) })} /></Field>
        <Field label="Ground spd (kt)"><Input type="number" step={10} value={tawsParams.ground_speed_kt} onChange={(e) => update({ ground_speed_kt: Number(e.target.value) })} /></Field>
        <Field label="Vert spd (fpm)"><Input type="number" step={100} value={tawsParams.vertical_speed_fpm} onChange={(e) => update({ vertical_speed_fpm: Number(e.target.value) })} /></Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={mode === "place-aircraft" ? "secondary" : "default"} disabled={!activeRegion} onClick={() => setMode(mode === "place-aircraft" ? "idle" : "place-aircraft")}>
          <Crosshair className="h-3.5 w-3.5" /> {mode === "place-aircraft" ? "Click map…" : aircraft ? "Move" : "Set Position"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => { stopSim(); setAircraft(null); setTawsResult(null); }}>Clear</Button>
        <Button size="sm" disabled={!aircraft} onClick={toggleSim}>
          {simRef.current !== null ? <><Square className="h-3.5 w-3.5" /> Stop</> : <><Play className="h-3.5 w-3.5" /> Simulate</>}
        </Button>
      </div>

      {tawsResult && (
        <>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Readout label="Min Clearance" value={tawsResult.min_clearance_ft == null ? "—" : `${fmtInt(tawsResult.min_clearance_ft)} ft`} />
            <Readout label="Path TTCI" value={fmt(tawsResult.mean_path_ttci, 3)} />
            <Readout label="Look-Ahead" value={`${fmt(tawsResult.envelope.horizon_nm, 1)} NM`} />
            <Readout label="TTCI Boost" value={`+${Math.round(tawsResult.envelope.ttci_time_gain_applied * 100)}%`} />
          </div>
          <TawsProfileChart result={tawsResult} />
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}
