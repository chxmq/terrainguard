import { useEffect, useRef, useState, useCallback } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, CircleMarker, Marker, Polyline, Rectangle, Popup, Tooltip,
  useMap, useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet-draw";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import { Pencil } from "lucide-react";
import { api, type Bounds } from "@/lib/api";
import { useTtci, riskColor } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { MsaProfileChart } from "@/components/charts";
import { cn, fmt, fmtInt } from "@/lib/utils";

const PRESETS: Array<{ name: string; bbox: Bounds }> = [
  { name: "Ladakh",      bbox: { south: 33.8, north: 34.5, west: 76.8, east: 77.8 } },
  { name: "Mont Blanc",  bbox: { south: 45.7, north: 46.1, west: 6.7,  east: 7.3  } },
  { name: "Everest",     bbox: { south: 27.8, north: 28.1, west: 86.7, east: 87.0 } },
  { name: "Andes (Cusco)", bbox: { south: -13.3, north: -13.0, west: -72.7, east: -72.4 } },
  { name: "Mt Rainier",  bbox: { south: 46.7, north: 47.0, west: -121.9, east: -121.6 } },
];
const TILE_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_URL_DARK  = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const BUF_DEG = 0.0834;

// ── Computing progress steps shown during TTCI calculation ──
const COMPUTE_STEPS = [
  "Downloading DEM tiles…",
  "Resampling elevation grid…",
  "Computing slope (Horn's method)…",
  "Computing TRI (Riley 1999)…",
  "Computing curvature…",
  "Computing elevation σ…",
  "Fusing TTCI weights…",
  "Rendering risk overlay…",
];

function useComputeProgress(active: boolean) {
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<boolean[]>([]);
  const ref = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) { setStep(0); setDone([]); return; }
    setStep(0); setDone([]);
    let idx = 0;
    const tick = () => {
      idx++;
      setDone((d) => [...d, true]);
      setStep(idx);
      if (idx < COMPUTE_STEPS.length - 1) {
        ref.current = setTimeout(tick, 900 + Math.random() * 600);
      }
    };
    ref.current = setTimeout(tick, 700);
    return () => { if (ref.current) clearTimeout(ref.current); };
  }, [active]);

  return { step, done };
}

// ── AAC audio playback hook ──
// Plays terrain-pullup.aac (place it in frontend/public/).
// CAUTION mode plays a separate obstacle-caution.aac if present, else a 440 Hz beep.
function useTerrainAudio() {
  const pullupRef   = useRef<HTMLAudioElement | null>(null);
  const cautionRef  = useRef<HTMLAudioElement | null>(null);
  const beepCtxRef  = useRef<AudioContext | null>(null);
  const lastLevelRef = useRef<"CLEAR" | "CAUTION" | "WARNING">("CLEAR");

  useEffect(() => {
    // Preload the AAC files from /public
    const pu = new Audio("/terrain-pullup.aac");
    pu.preload = "auto";
    pullupRef.current = pu;

    const cau = new Audio("/obstacle-caution.aac");
    cau.preload = "auto";
    cautionRef.current = cau;

    return () => {
      pu.pause();
      cau.pause();
    };
  }, []);

  const playWarning = useCallback(() => {
    const audio = pullupRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.play().catch(() => {/* autoplay blocked — user hasn't interacted yet */});
  }, []);

  const playBeep = useCallback(() => {
    // Try the caution AAC first; fall back to a synthesised beep
    const audio = cautionRef.current;
    if (audio && audio.readyState >= 2) {
      audio.currentTime = 0;
      audio.play().catch(() => synthBeep());
    } else {
      synthBeep();
    }
  }, []);

  function synthBeep() {
    try {
      if (!beepCtxRef.current) beepCtxRef.current = new AudioContext();
      const ctx = beepCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
    } catch { /* audio unavailable */ }
  }

  const trigger = useCallback(
    (level: "CLEAR" | "CAUTION" | "WARNING") => {
      const prev = lastLevelRef.current;
      lastLevelRef.current = level;
      if (level === "WARNING" && prev !== "WARNING") playWarning();
      if (level === "CAUTION" && prev === "CLEAR")   playBeep();
    },
    [playWarning, playBeep],
  );

  return { trigger };
}

function FitToRegion() {
  const { activeRegion } = useTtci();
  const map = useMap();
  useEffect(() => {
    if (activeRegion)
      map.fitBounds(
        [[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]],
        { padding: [24, 24] },
      );
  }, [activeRegion, map]);
  return null;
}

function TileLayerThemed() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return (
    <TileLayer
      url={dark ? TILE_URL_DARK : TILE_URL_LIGHT}
      subdomains="abcd"
      attribution="&copy; OpenStreetMap &copy; CARTO"
      maxZoom={18}
    />
  );
}

function ClickLayer() {
  const { activeRegion, setLastQuery, lastQuery, toast } = useTtci();
  const { mode, setMode, setAircraft } = useTools();
  useMapEvents({
    click: async (e) => {
      if (mode === "place-aircraft") {
        setAircraft({ lat: e.latlng.lat, lon: e.latlng.lng });
        setMode("idle");
        return;
      }
      if (mode !== "idle" || !activeRegion) return;
      try {
        setLastQuery(await api.query(e.latlng.lat, e.latlng.lng));
      } catch (err) {
        toast((err as Error).message || "Point query failed.", "error");
      }
    },
  });
  if (!lastQuery) return null;
  return (
    <CircleMarker
      center={[lastQuery.lat, lastQuery.lon]}
      radius={7}
      pathOptions={{ color: "#fff", weight: 2, fillColor: lastQuery.risk_color, fillOpacity: 0.9 }}
    >
      <Popup>
        <div className="font-sans text-xs">
          <div className="mb-1 font-bold">
            TTCI {fmt(lastQuery.ttci, 3)}{" "}
            <span style={{ color: lastQuery.risk_color }}>{lastQuery.risk_level}</span>
          </div>
          <div>Elevation: {fmt(lastQuery.elevation_m, 0)} m · {fmtInt(lastQuery.elevation_ft)} ft</div>
          <div>Slope: {fmt(lastQuery.metrics.slope_deg, 1)}° · TRI: {fmt(lastQuery.metrics.tri_m, 1)} m</div>
        </div>
      </Popup>
    </CircleMarker>
  );
}

function DrawController({ onArea }: { onArea: (b: Bounds) => void }) {
  const map = useMap();
  const { mode, setMode, setRouteWaypoints } = useTools();
  useEffect(() => {
    if (mode !== "draw-area" && mode !== "draw-route") return;
    const LD = (L as any).Draw;
    const handler =
      mode === "draw-area"
        ? new LD.Rectangle(map, {
            shapeOptions: { color: "#06b6d4", weight: 2, fillColor: "#06b6d4", fillOpacity: 0.05 },
          })
        : new LD.Polyline(map, {
            shapeOptions: { color: "#3b82f6", weight: 3, dashArray: "8,6" },
            maxPoints: 50,
          });
    handler.enable();
    const onCreated = (e: any) => {
      if (mode === "draw-area") {
        const b = e.layer.getBounds();
        onArea({ south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() });
      } else {
        setRouteWaypoints(e.layer.getLatLngs().map((ll: any) => [ll.lat, ll.lng]));
        setMode("idle");
      }
    };
    map.on((L as any).Draw.Event.CREATED, onCreated);
    return () => {
      map.off((L as any).Draw.Event.CREATED, onCreated);
      try { handler.disable(); } catch { /* noop */ }
    };
  }, [mode, map, onArea, setMode, setRouteWaypoints]);
  return null;
}

function MsaLayers() {
  const { riskLevels } = useTtci();
  const { routeWaypoints, msaSectors } = useTools();
  return (
    <>
      {routeWaypoints.length > 1 && (
        <Polyline
          positions={routeWaypoints.map(([la, lo]) => [la, lo])}
          pathOptions={{ color: "#3b82f6", weight: 3, dashArray: "8,6" }}
        />
      )}
      {routeWaypoints.map(([la, lo], i) => (
        <CircleMarker
          key={`wp${i}`}
          center={[la, lo]}
          radius={5}
          pathOptions={{ color: "#fff", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}
        >
          <Tooltip permanent direction="top">WP{i + 1}</Tooltip>
        </CircleMarker>
      ))}
      {msaSectors.map((s) => {
        const color = s.ttci ? riskColor(riskLevels, s.ttci.mean) : "#888";
        const bounds: [[number, number], [number, number]] = [
          [Math.min(s.from.lat, s.to.lat) - BUF_DEG, Math.min(s.from.lon, s.to.lon) - BUF_DEG],
          [Math.max(s.from.lat, s.to.lat) + BUF_DEG, Math.max(s.from.lon, s.to.lon) + BUF_DEG],
        ];
        return (
          <Rectangle
            key={`sec${s.sector}`}
            bounds={bounds}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.08, weight: 1, dashArray: "4,4" }}
          >
            <Popup>
              <div className="font-sans text-xs">
                <div className="font-bold">Sector {s.sector}</div>
                <div>Min Safe Alt: <strong>{fmtInt(s.msa_ft)} ft</strong></div>
                <div>Max terrain: {fmtInt(s.max_terrain_ft)} ft</div>
              </div>
            </Popup>
          </Rectangle>
        );
      })}
    </>
  );
}

/** Animated rotated aircraft icon following the Fly Route simulation. */
function FlyRouteLayers() {
  const { flyPosition } = useTools();
  if (!flyPosition) return null;

  const { clearance_ft, heading_deg } = flyPosition;
  const fillColor =
    clearance_ft < 1500 ? "#e74c3c"
    : clearance_ft < 3000 ? "#e67e22"
    : "#2ecc71";
  const glowAlpha = clearance_ft < 1500 ? "0.55" : clearance_ft < 3000 ? "0.4" : "0.35";
  const glow = fillColor.replace("#", "");
  const r = parseInt(glow.slice(0, 2), 16);
  const g = parseInt(glow.slice(2, 4), 16);
  const b = parseInt(glow.slice(4, 6), 16);
  const glowRgba = `rgba(${r},${g},${b},${glowAlpha})`;

  const html = `
    <div style="position:relative;width:44px;height:44px">
      <div style="position:absolute;top:50%;left:50%;width:44px;height:44px;
        transform:translate(-50%,-50%);border-radius:50%;background:${glowRgba}"></div>
      <svg width="44" height="44" viewBox="-22 -22 44 44"
        style="position:absolute;top:0;left:0;transform:rotate(${heading_deg}deg)">
        <path d="M0,-16 L4,0 L16,7 L9,9 L3,3.5 L2,13 L5,14.5 L0,13.5 L-5,14.5 L-2,13 L-3,3.5 L-9,9 L-16,7 L-4,0 Z"
          fill="${fillColor}" stroke="rgba(255,255,255,0.95)" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`;

  const icon = L.divIcon({ html, className: "", iconSize: [44, 44], iconAnchor: [22, 22] });

  return <Marker position={[flyPosition.lat, flyPosition.lon]} icon={icon} />;
}

function clearanceColor(ft: number, env: { warning_clearance_ft: number; caution_clearance_ft: number }) {
  if (ft < env.warning_clearance_ft) return "#e74c3c";
  if (ft < env.caution_clearance_ft) return "#e67e22";
  return "#2ecc71";
}

function TawsLayers() {
  const { aircraft, tawsResult } = useTools();
  if (!aircraft) return null;
  const segs: JSX.Element[] = [];
  if (tawsResult) {
    let prev: [number, number] = [aircraft.lat, aircraft.lon];
    tawsResult.profile.forEach((p, i) => {
      segs.push(
        <Polyline
          key={`seg${i}`}
          positions={[prev, [p.lat, p.lon]]}
          pathOptions={{ color: clearanceColor(p.clearance_ft, tawsResult.envelope), weight: 4, opacity: 0.9 }}
        />,
      );
      prev = [p.lat, p.lon];
    });
  }
  return (
    <>
      {segs}
      <CircleMarker
        center={[aircraft.lat, aircraft.lon]}
        radius={7}
        pathOptions={{ color: "#fff", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}
      >
        <Tooltip permanent direction="center">✈</Tooltip>
      </CircleMarker>
      {tawsResult?.trigger && (
        <CircleMarker
          center={[tawsResult.trigger.lat, tawsResult.trigger.lon]}
          radius={9}
          pathOptions={{ color: "#fff", weight: 2, fillColor: tawsResult.alert_color, fillOpacity: 0.95 }}
        >
          <Popup>
            <div className="font-sans text-xs">
              <div className="font-bold" style={{ color: tawsResult.alert_color }}>{tawsResult.callout}</div>
              <div>Terrain: {fmtInt(tawsResult.trigger.terrain_ft)} ft</div>
              <div>Clearance: {fmtInt(tawsResult.trigger.clearance_ft)} ft @ {fmt(tawsResult.trigger.distance_nm, 1)} NM</div>
            </div>
          </Popup>
        </CircleMarker>
      )}
    </>
  );
}

function CfitLayers() {
  const { validation, cfitShown } = useTools();
  if (!cfitShown || !validation) return null;
  return (
    <>
      {validation.accidents.map((a) => (
        <CircleMarker
          key={a.flight}
          center={[a.lat, a.lon]}
          radius={7}
          pathOptions={{ color: "#fff", weight: 2, fillColor: a.risk_color, fillOpacity: 0.9 }}
        >
          <Popup>
            <div className="font-sans text-xs">
              <div className="font-bold">{a.flight} <span style={{ color: a.risk_color }}>{a.risk_level}</span></div>
              <div>{a.date} · {a.fatalities} fatalities</div>
              <div>{a.site}, {a.country}</div>
              <div>TTCI {fmt(a.site_ttci, 2)} ({fmt(a.site_max_1km, 2)} @1km)</div>
              <a href={a.source} target="_blank" rel="noopener">Accident report ↗</a>
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </>
  );
}

/** Persistent TTCI risk legend */
const FALLBACK_LEVELS = [
  { label: "Very Low", color: "#2ecc71" },
  { label: "Low",      color: "#f1c40f" },
  { label: "Moderate", color: "#e67e22" },
  { label: "High",     color: "#e74c3c" },
  { label: "Critical", color: "#8e44ad" },
];

function RiskLegend() {
  const { riskLevels, activeRegion } = useTtci();
  if (!activeRegion) return null;
  const levels = riskLevels.length
    ? riskLevels.map((l) => ({ label: l.label, color: l.color }))
    : FALLBACK_LEVELS;
  return (
    <div className="absolute bottom-7 left-3 z-[700] flex items-center gap-2 rounded-lg border border-border/60 bg-card/92 px-3 py-1.5 shadow-lg backdrop-blur-sm">
      <span className="mr-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        TTCI
      </span>
      {levels.map((l) => (
        <div key={l.label} className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
          <span className="text-[10px] text-muted-foreground">{l.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Floating pilot HUD shown during Fly Route simulation. */
function PilotHUD() {
  const { flyPosition } = useTools();
  const { riskLevels } = useTtci();
  if (!flyPosition) return null;

  const { elevation_m, msa_ft, clearance_ft, sectorLabel, progressPct, ttci } = flyPosition;
  const elevation_ft = elevation_m / 0.3048;
  const ttciColor = ttci != null ? riskColor(riskLevels, ttci) : "#888";

  const clearStatus =
    clearance_ft < 1500 ? "WARNING"
    : clearance_ft < 3000 ? "CAUTION"
    : "CLEAR";
  const clearColor =
    clearStatus === "WARNING" ? "#e74c3c"
    : clearStatus === "CAUTION" ? "#e67e22"
    : "#2ecc71";

  return (
    <div className="absolute right-3 top-16 z-[700] w-56 overflow-hidden rounded-xl border border-border/60 bg-card/96 shadow-2xl backdrop-blur-md">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-border/50 bg-secondary/40 px-3 py-1.5">
        <span className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
          Route Simulation
        </span>
        <span className="rounded bg-primary/20 px-2 py-0.5 font-mono text-[10px] font-bold text-primary">
          {sectorLabel}
        </span>
      </div>

      <div className="space-y-3 p-3">
        {ttci != null && (
          <div>
            <div className="mb-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">TTCI Score</div>
            <div className="font-mono text-2xl font-extrabold leading-none" style={{ color: ttciColor }}>
              {ttci.toFixed(3)}
            </div>
          </div>
        )}

        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">Terrain Elev</div>
          <div className="font-mono text-lg font-bold leading-none">
            {Math.round(elevation_m).toLocaleString()} m
          </div>
          <div className="font-mono text-[11px] text-muted-foreground">
            {Math.round(elevation_ft).toLocaleString()} ft
          </div>
        </div>

        <div>
          <div className="mb-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">
            Min Safe Altitude
          </div>
          <div className="font-mono text-lg font-bold leading-none text-primary">
            {Math.round(msa_ft).toLocaleString()} ft
          </div>
        </div>

        {/* Clearance banner */}
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-center",
            clearStatus === "WARNING" && "animate-pulse border-risk-high/60 bg-risk-high/15",
            clearStatus === "CAUTION" && "animate-obstacle-strobe border-2",
            clearStatus === "CLEAR"   && "border-risk-vlow/40 bg-risk-vlow/8",
          )}
          style={clearStatus === "CAUTION" ? { borderColor: "rgba(230,126,34,0.9)" } : {}}
        >
          <div className="text-[9px] uppercase tracking-widest text-muted-foreground">Clearance</div>
          <div className="font-mono text-2xl font-extrabold leading-none" style={{ color: clearColor }}>
            {Math.round(clearance_ft).toLocaleString()} ft
          </div>
          <div className="mt-0.5 text-[10px] font-bold" style={{ color: clearColor }}>
            {clearStatus}
          </div>
        </div>

        {/* Progress bar */}
        <div>
          <div className="mb-1 flex justify-between text-[9px] text-muted-foreground">
            <span>Route progress</span>
            <span className="font-mono">{Math.round(progressPct)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary transition-all duration-100"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Full-width cockpit instrument strip shown at the bottom of the map during flight simulation. */
function CockpitStrip() {
  const { flyPosition, msaProfile, msaSectors } = useTools();
  const { riskLevels } = useTtci();
  if (!flyPosition || msaProfile.length === 0) return null;

  const { elevation_m, msa_ft, clearance_ft, sectorLabel, progressPct, ttci } = flyPosition;
  const elevation_ft = elevation_m / 0.3048;
  const clearStatus =
    clearance_ft < 1500 ? "WARNING" : clearance_ft < 3000 ? "CAUTION" : "CLEAR";
  const clearColor =
    clearStatus === "WARNING" ? "#e74c3c" : clearStatus === "CAUTION" ? "#e67e22" : "#2ecc71";
  const ttciColor = ttci != null ? riskColor(riskLevels, ttci) : "#888";

  return (
    <div className="absolute bottom-0 left-0 right-0 z-[750] border-t border-border bg-card/95 backdrop-blur-md">
      <div className="flex items-stretch" style={{ height: "180px" }}>
        {/* Left — key numbers */}
        <div className="flex w-52 flex-shrink-0 flex-col justify-around border-r border-border px-4 py-3">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Terrain Elevation
            </div>
            <div className="font-mono text-xl font-bold leading-tight text-foreground">
              {Math.round(elevation_m).toLocaleString()} m
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {Math.round(elevation_ft).toLocaleString()} ft
            </div>
          </div>
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Min Safe Altitude
            </div>
            <div className="font-mono text-xl font-bold leading-tight text-primary">
              {Math.round(msa_ft).toLocaleString()} ft
            </div>
          </div>
          <div className="flex items-end gap-4">
            <div>
              <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">Sector</div>
              <div className="font-mono text-sm font-bold text-primary">{sectorLabel}</div>
            </div>
            {ttci != null && (
              <div>
                <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">TTCI</div>
                <div className="font-mono text-sm font-bold" style={{ color: ttciColor }}>
                  {ttci.toFixed(3)}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Center — elevation profile */}
        <div className="min-w-0 flex-1 px-1 py-1.5">
          <MsaProfileChart
            profile={msaProfile}
            sectors={msaSectors}
            flyDistKm={flyPosition.distance_km}
            className="h-full"
          />
        </div>

        {/* Right — clearance status */}
        <div className="flex w-44 flex-shrink-0 flex-col items-center justify-center gap-3 border-l border-border px-3 py-3">
          <div
            className={cn(
              "w-full rounded px-2 py-2.5 text-center",
              clearStatus === "WARNING" && "animate-pulse border-2 border-risk-high/70 bg-risk-high/12",
              clearStatus === "CAUTION" && "animate-obstacle-strobe border-2",
              clearStatus === "CLEAR"   && "border border-risk-vlow/40 bg-risk-vlow/6",
            )}
            style={clearStatus === "CAUTION" ? { borderColor: "rgba(230,126,34,0.9)" } : {}}
          >
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Clearance
            </div>
            <div className="font-mono text-4xl font-black leading-tight" style={{ color: clearColor }}>
              {Math.round(clearance_ft).toLocaleString()}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">ft</div>
            <div className="mt-0.5 text-[11px] font-black tracking-wider" style={{ color: clearColor }}>
              {clearStatus}
            </div>
          </div>
          <div className="w-full">
            <div className="mb-1.5 flex justify-between text-[9px] text-muted-foreground">
              <span>Progress</span>
              <span className="font-mono font-semibold text-foreground">{Math.round(progressPct)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Full-screen WARNING overlay: red pulse + "TERRAIN — PULL UP" banner.
 * CAUTION overlay: amber flash border + "OBSTACLE AHEAD" banner.
 * Both trigger their respective audio cues via useTerrainAudio.
 */
function WarningOverlay() {
  const { flyPosition } = useTools();
  const { trigger } = useTerrainAudio();

  const clearance = flyPosition?.clearance_ft ?? Infinity;
  const level: "CLEAR" | "CAUTION" | "WARNING" =
    clearance < 1500 ? "WARNING"
    : clearance < 3000 ? "CAUTION"
    : "CLEAR";

  useEffect(() => {
    trigger(level);
  }, [level, trigger]);

  if (!flyPosition || level === "CLEAR") return null;

  if (level === "WARNING") {
    return (
      <div className="pointer-events-none absolute inset-0 z-[760]">
        <div className="absolute inset-0 animate-pulse border-[6px] border-red-500/85" />
        <div className="absolute left-0 right-0 top-0 flex items-center justify-center bg-red-600/95 py-2.5 backdrop-blur-sm">
          <span className="animate-pulse font-mono text-sm font-black uppercase tracking-[0.28em] text-white">
            ⚠ &nbsp;TERRAIN — PULL UP&nbsp; ⚠
          </span>
        </div>
      </div>
    );
  }

  // CAUTION — amber flash with obstacle warning
  return (
    <div className="pointer-events-none absolute inset-0 z-[760]">
      <div className="animate-amber-flash absolute inset-0 border-[5px] border-amber-500/80" />
      <div className="animate-amber-flash absolute left-0 right-0 top-0 flex items-center justify-center bg-amber-500/90 py-2 backdrop-blur-sm">
        <span className="font-mono text-sm font-black uppercase tracking-[0.24em] text-white">
          ⚠ &nbsp;OBSTACLE AHEAD — CAUTION&nbsp; ⚠
        </span>
      </div>
    </div>
  );
}

export function MapView() {
  const { status, activeRegion, overlayVersion, activate, toast } = useTtci();
  const { mode, setMode, view, setView, overlayOpacity, showOverlay } = useTools();
  const [source, setSource] = useState("tiles");
  const onAreaRef = useRef<(b: Bounds) => void>(() => {});

  // Step-by-step compute progress
  const computing = status === "computing";
  const { step, done } = useComputeProgress(computing);

  onAreaRef.current = async (b: Bounds) => {
    setMode("idle");
    try { await activate(b, source); } catch { /* handled */ }
  };

  const showPrompt = status === "empty" || (!activeRegion && status !== "computing");

  return (
    <div className="relative h-full w-full">
      <MapContainer center={[25, 82]} zoom={3} className="h-full w-full" zoomControl attributionControl>
        <TileLayerThemed />
        {activeRegion && showOverlay && (
          <ImageOverlay
            key={overlayVersion}
            url={api.overlayUrl()}
            bounds={[[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]]}
            opacity={overlayOpacity}
          />
        )}
        <FitToRegion />
        <ClickLayer />
        <DrawController onArea={(b) => onAreaRef.current(b)} />
        <MsaLayers />
        <FlyRouteLayers />
        <TawsLayers />
        <CfitLayers />
      </MapContainer>

      {/* Pilot HUD */}
      <PilotHUD />

      {/* Cockpit strip */}
      <CockpitStrip />

      {/* WARNING / CAUTION overlay with audio */}
      <WarningOverlay />

      {/* Risk legend */}
      <RiskLegend />

      {/* Map / Globe view toggle */}
      <button
        onClick={() => setView(view === "2d" ? "3d" : "2d")}
        className="absolute bottom-7 right-3 z-[700] rounded border border-border bg-card/90 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground shadow backdrop-blur transition-colors hover:border-primary hover:text-primary"
      >
        {view === "3d" ? "2D Map" : "3D Globe"}
      </button>

      <button
        onClick={() => {
          setMode("draw-area");
          toast("Drag a box on the map to select the area to assess.", "info");
        }}
        className="absolute left-3 top-3 z-[700] flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-2 text-xs font-semibold shadow-md backdrop-blur transition-colors hover:border-primary hover:text-primary"
      >
        <Pencil className="h-3.5 w-3.5" /> Select area
      </button>

      {showPrompt && (
        <div className="absolute inset-0 z-[680] flex items-center justify-center bg-background/55 backdrop-blur-sm">
          <div className="w-[min(460px,calc(100%-48px))] rounded-lg border border-border bg-card p-7 text-center shadow-lg">
            <h2 className="mb-2 bg-gradient-to-r from-primary to-risk-critical bg-clip-text text-xl font-extrabold text-transparent">
              Assess any terrain on Earth
            </h2>
            <p className="mb-5 text-sm text-muted-foreground">
              Draw a box on the map to compute the Terrain Topography Complexity Index for that
              area — or jump to a preset region below.
            </p>
            <div className="mb-4 flex items-center justify-center gap-2">
              <Button onClick={() => { setMode("draw-area"); toast("Drag a box on the map to select the area.", "info"); }}>
                <Pencil className="h-4 w-4" /> Draw area on map
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                DEM
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="tiles">SRTM 30 m</option>
                  <option value="copernicus">Copernicus GLO-30</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-muted-foreground">Presets:</span>
              {PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => activate(p.bbox, source).catch(() => {})}
                  className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Step-by-step compute progress overlay ── */}
      {computing && (
        <div className="absolute inset-0 z-[690] flex items-center justify-center bg-background/70 backdrop-blur">
          <div className="w-72 rounded-xl border border-border bg-card p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
              <div>
                <div className="text-sm font-bold text-foreground">Computing TTCI</div>
                <div className="text-[11px] text-muted-foreground">Processing DEM data…</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {COMPUTE_STEPS.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 rounded-full border text-[8px] flex items-center justify-center font-bold",
                      done[i]
                        ? "border-emerald-500 bg-emerald-500 text-white"
                        : i === step
                        ? "animate-pulse border-primary bg-primary/20 text-primary"
                        : "border-border bg-secondary",
                    )}
                  >
                    {done[i] ? "✓" : ""}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      done[i] ? "text-emerald-600 line-through" : i === step ? "text-primary font-semibold" : "text-muted-foreground",
                    )}
                  >
                    {s}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
