import { useEffect, useRef } from "react";
import { Crosshair, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools, type TawsParams } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TawsProfileChart } from "@/components/charts";
import { cn, fmt, fmtInt, destinationPoint } from "@/lib/utils";

const LEVEL_STYLE: Record<string, string> = {
  WARNING: "border-risk-high/60 bg-risk-high/10 text-risk-high",
  CAUTION: "border-risk-moderate/50 bg-risk-moderate/8 text-risk-moderate",
  CLEAR:   "border-border bg-secondary/40 text-muted-foreground",
};

export function TawsPanel() {
  const { activeRegion, toast } = useTtci();
  const {
    mode, setMode,
    aircraft, setAircraft,
    tawsParams, setTawsParams,
    tawsResult, setTawsResult,
  } = useTools();
  const simRef = useRef<number | null>(null);
  const aircraftRef = useRef(aircraft);
  aircraftRef.current = aircraft;

  const run = async (ac = aircraftRef.current, params = tawsParams) => {
    if (!ac) return;
    try {
      setTawsResult(await api.tawsLookahead({ lat: ac.lat, lon: ac.lon, ...params }));
    } catch (err) {
      toast((err as Error).message || "Look-ahead failed.", "error");
      stopSim();
    }
  };

  // Recompute when the aircraft moves; debounce param edits so typing doesn't spam the API.
  useEffect(() => {
    if (!aircraft || simRef.current !== null) return;
    const id = window.setTimeout(() => { run(aircraft, tawsParams); }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aircraft, tawsParams]);

  const stopSim = () => {
    if (simRef.current !== null) { clearInterval(simRef.current); simRef.current = null; }
  };
  useEffect(() => () => stopSim(), []);

  const toggleSim = () => {
    if (simRef.current !== null) { stopSim(); return; }
    const start = aircraftRef.current;
    if (!start) return;
    let steps = 0;
    let pos = { ...start };
    simRef.current = window.setInterval(async () => {
      steps++;
      const [lat, lon] = destinationPoint(pos.lat, pos.lon, tawsParams.heading_deg, 0.4 * 1.852);
      pos = { lat, lon };
      setAircraft(pos);
      await run(pos, tawsParams);
      if (steps >= 60) stopSim();
    }, 650);
  };

  const update = (patch: Partial<TawsParams>) => setTawsParams({ ...tawsParams, ...patch });
  const level = tawsResult?.alert_level ?? "CLEAR";

  return (
    <div className="space-y-5">
      {!activeRegion ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Select a terrain area on the map first.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Set the aircraft position and heading, then see terrain warnings along the flight path.
        </p>
      )}

      {/* ── Alert Status ── */}
      <section>
        <SectionHead>Alert Status</SectionHead>
        <div className={cn("rounded border p-4", LEVEL_STYLE[level], level === "WARNING" && "animate-pulse")}>
          <div className="font-mono text-2xl font-black leading-none">
            {tawsResult ? level : "NO DATA"}
          </div>
          <div className="mt-1 text-xs font-medium">
            {tawsResult ? tawsResult.callout : "Place an aircraft to begin"}
          </div>
        </div>
      </section>

      {/* ── Aircraft State ── */}
      <section>
        <SectionHead>Aircraft State</SectionHead>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Altitude (ft)">
            <Input type="number" step={500} value={tawsParams.altitude_ft}
              onChange={(e) => update({ altitude_ft: Number(e.target.value) })} />
          </Field>
          <Field label="Heading (°)">
            <Input type="number" step={5} value={tawsParams.heading_deg}
              onChange={(e) => update({ heading_deg: Number(e.target.value) })} />
          </Field>
          <Field label="Ground speed (kt)">
            <Input type="number" step={10} value={tawsParams.ground_speed_kt}
              onChange={(e) => update({ ground_speed_kt: Number(e.target.value) })} />
          </Field>
          <Field label="Vert speed (fpm)">
            <Input type="number" step={100} value={tawsParams.vertical_speed_fpm}
              onChange={(e) => update({ vertical_speed_fpm: Number(e.target.value) })} />
          </Field>
        </div>
      </section>

      {/* ── Controls ── */}
      <section>
        <SectionHead>Controls</SectionHead>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === "place-aircraft" ? "secondary" : "default"}
            disabled={!activeRegion}
            onClick={() => setMode(mode === "place-aircraft" ? "idle" : "place-aircraft")}
          >
            <Crosshair className="h-3.5 w-3.5" />
            {mode === "place-aircraft" ? "Click map…" : aircraft ? "Move aircraft" : "Set position"}
          </Button>
          <Button size="sm" variant="outline"
            onClick={() => { stopSim(); setAircraft(null); setTawsResult(null); }}>
            Clear
          </Button>
          <Button size="sm" disabled={!aircraft} onClick={toggleSim}>
            {simRef.current !== null
              ? <><Square className="h-3.5 w-3.5" /> Stop</>
              : <><Play  className="h-3.5 w-3.5" /> Simulate</>}
          </Button>
        </div>
      </section>

      {/* ── Readouts ── */}
      {tawsResult && (
        <section>
          <SectionHead>Readouts</SectionHead>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <DataField label="Min Clearance"
              value={tawsResult.min_clearance_ft == null ? "—" : `${fmtInt(tawsResult.min_clearance_ft)} ft`} />
            <DataField label="Path TTCI"   value={fmt(tawsResult.mean_path_ttci, 3)} accent />
            <DataField label="Look-Ahead"  value={`${fmt(tawsResult.envelope.horizon_nm, 1)} NM`} />
            <DataField label="TTCI Boost"  value={`+${Math.round(tawsResult.envelope.ttci_time_gain_applied * 100)}%`} accent />
          </div>
          <div className="mt-4">
            <TawsProfileChart result={tawsResult} />
          </div>
        </section>
      )}
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

function DataField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-mono text-sm font-bold leading-tight", accent ? "text-primary" : "text-foreground")}>
        {value}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
