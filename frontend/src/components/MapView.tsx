import { useEffect, useRef, useState } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, CircleMarker, Marker, Polyline, Popup, Tooltip,
  ZoomControl,
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
import { cn, fmt, fmtInt, msaClearanceColor, msaClearanceStatus, MSA_CLEARANCE_WARNING_FT } from "@/lib/utils";

const MAX_REGION_SPAN_DEG = 12;
const MIN_DRAW_ZOOM = 7;

function spanTooLarge(b: Bounds): boolean {
  return (b.north - b.south) > MAX_REGION_SPAN_DEG || (b.east - b.west) > MAX_REGION_SPAN_DEG;
}

function spanErrorMessage(b: Bounds): string {
  const latSpan = (b.north - b.south).toFixed(1);
  const lonSpan = (b.east - b.west).toFixed(1);
  return (
    `Selected area is ${latSpan}° × ${lonSpan}° (max ${MAX_REGION_SPAN_DEG}° per side). ` +
    "Zoom in on the map and draw a smaller box."
  );
}

/** Bump map zoom when the user starts drawing so boxes aren't continent-sized. */
function PrepareDrawArea() {
  const map = useMap();
  const { mode } = useTools();
  const { toast } = useTtci();
  useEffect(() => {
    if (mode !== "draw-area") return;
    if (map.getZoom() < MIN_DRAW_ZOOM) {
      map.setZoom(MIN_DRAW_ZOOM);
      toast("Zoomed in for area selection — drag a box around the terrain you want.", "info");
    }
  }, [mode, map, toast]);
  return null;
}

const PRESETS: Array<{ name: string; bbox: Bounds }> = [
  { name: "Ladakh", bbox: { south: 33.8, north: 34.5, west: 76.8, east: 77.8 } },
  { name: "Mont Blanc", bbox: { south: 45.7, north: 46.1, west: 6.7, east: 7.3 } },
  { name: "Everest", bbox: { south: 27.8, north: 28.1, west: 86.7, east: 87.0 } },
  { name: "Andes (Cusco)", bbox: { south: -13.3, north: -13.0, west: -72.7, east: -72.4 } },
  { name: "Mt Rainier", bbox: { south: 46.7, north: 47.0, west: -121.9, east: -121.6 } },
];
const TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

const MODE_HINTS: Record<string, string> = {
  "draw-area": "Drag a box around the terrain you want to analyze",
  "draw-route": "Click on the map to place waypoints · double-click to finish",
  "place-aircraft": "Click the map to place the aircraft",
};

function FitToRegion() {
  const { activeRegion } = useTtci();
  const map = useMap();
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!activeRegion) return;
    const key = `${activeRegion.south},${activeRegion.north},${activeRegion.west},${activeRegion.east}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    map.fitBounds(
      [[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]],
      { padding: [24, 24] },
    );
  }, [activeRegion, map]);
  return null;
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
  const { toast } = useTtci();
  const { mode, setMode, setRouteWaypoints } = useTools();
  useEffect(() => {
    if (mode !== "draw-area" && mode !== "draw-route") return;
    const LD = (L as any).Draw;
    const handler =
      mode === "draw-area"
        ? new LD.Rectangle(map, {
            // leaflet-draw 1.0.4's area tooltip (readableArea) throws
            // "type is not defined" on newer Leaflet — disable it.
            showArea: false,
            metric: true,
            shapeOptions: { color: "#06b6d4", weight: 2, fillColor: "#06b6d4", fillOpacity: 0.05 },
          })
        : new LD.Polyline(map, {
            showLength: false,
            shapeOptions: { color: "#3b82f6", weight: 3, dashArray: "8,6" },
            maxPoints: 50,
          });
    handler.enable();
    const onCreated = (e: any) => {
      if (mode === "draw-area") {
        const b = e.layer.getBounds();
        const south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();
        const bbox = { south, north, west, east };
        if (spanTooLarge(bbox)) {
          map.removeLayer(e.layer);
          setMode("idle");
          toast(spanErrorMessage(bbox), "error");
          return;
        }
        map.removeLayer(e.layer);
        onArea(bbox);
      } else {
        const wps = e.layer.getLatLngs().map((ll: any) => [ll.lat, ll.lng] as [number, number]);
        map.removeLayer(e.layer);
        setRouteWaypoints(wps);
        setMode("idle");
      }
    };
    map.on((L as any).Draw.Event.CREATED, onCreated);
    return () => {
      map.off((L as any).Draw.Event.CREATED, onCreated);
      try { handler.disable(); } catch { /* noop */ }
    };
  }, [mode, map, onArea, setMode, setRouteWaypoints, toast]);
  return null;
}

function MsaLayers() {
  const { riskLevels } = useTtci();
  const { routeWaypoints, msaSectors } = useTools();

  if (msaSectors.length > 0) {
    return (
      <>
        {msaSectors.map((s) => {
          const color = s.ttci ? riskColor(riskLevels, s.ttci.mean) : "#2563eb";
          return (
            <Polyline
              key={`sec${s.sector}`}
              positions={[[s.from.lat, s.from.lon], [s.to.lat, s.to.lon]]}
              pathOptions={{ color, weight: 5, opacity: 0.92, lineCap: "round", lineJoin: "round" }}
            >
              <Popup>
                <div className="font-sans text-xs">
                  <div className="font-semibold">Leg {s.sector}</div>
                  <div>Min safe altitude: <strong>{fmtInt(s.msa_ft)} ft</strong></div>
                  <div>Highest terrain: {fmtInt(s.max_terrain_ft)} ft</div>
                </div>
              </Popup>
            </Polyline>
          );
        })}
        {routeWaypoints.map(([la, lo], i) => (
          <CircleMarker
            key={`wp${i}`}
            center={[la, lo]}
            radius={6}
            pathOptions={{ color: "#1e40af", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}
          >
            <Tooltip direction="top">{i + 1}</Tooltip>
          </CircleMarker>
        ))}
      </>
    );
  }

  if (routeWaypoints.length < 2) return null;

  return (
    <>
      <Polyline
        positions={routeWaypoints.map(([la, lo]) => [la, lo])}
        pathOptions={{ color: "#2563eb", weight: 4, dashArray: "10,8", opacity: 0.9 }}
      />
      {routeWaypoints.map(([la, lo], i) => (
        <CircleMarker
          key={`wp${i}`}
          center={[la, lo]}
          radius={6}
          pathOptions={{ color: "#1e40af", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}
        >
          <Tooltip direction="top">{i + 1}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

function MapModeBanner() {
  const { mode } = useTools();
  if (mode === "idle") return null;
  const hint = MODE_HINTS[mode];
  if (!hint) return null;
  return (
    <div className="pointer-events-none absolute left-1/2 top-16 z-[700] -translate-x-1/2 panel-float px-4 py-2.5 text-body-sm font-medium text-foreground">
      {hint}
    </div>
  );
}

/** Animated rotated aircraft icon following the Fly Route simulation. */
function FlyRouteLayers() {
  const { flyPosition } = useTools();
  if (!flyPosition) return null;

  const { clearance_ft, heading_deg } = flyPosition;
  const fillColor = msaClearanceColor(clearance_ft);
  const clearStatus = msaClearanceStatus(clearance_ft);
  const glowAlpha = clearStatus === "WARNING" ? "0.55" : clearStatus === "CAUTION" ? "0.4" : "0.35";
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

/** Persistent TTCI risk legend — visible in both 2D and 3D (z-700 > Globe z-600). */
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
    <div className="absolute bottom-7 left-3 z-[700] flex items-center gap-2 panel-float px-3 py-1.5">
      <span className="text-label mr-1 mb-0">Risk</span>
      {levels.map((l) => (
        <div key={l.label} className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: l.color }} />
          <span className="text-[11px] text-body">{l.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Bottom instrument bar during route fly-through simulation. */
function CockpitStrip() {
  const { flyPosition, msaProfile, msaSectors } = useTools();
  const { riskLevels } = useTtci();
  if (!flyPosition || msaProfile.length === 0) return null;

  const { elevation_m, msa_ft, clearance_ft, sectorLabel, progressPct, ttci } = flyPosition;
  const elevation_ft = elevation_m / 0.3048;
  const clearStatus = msaClearanceStatus(clearance_ft);
  const clearColor = msaClearanceColor(clearance_ft);
  const ttciColor = ttci != null ? riskColor(riskLevels, ttci) : "#888";

  return (
    <div className="absolute bottom-0 left-0 right-0 z-[750] border-t border-border bg-card/95 backdrop-blur-md">
      <div className="flex items-stretch" style={{ height: "180px" }}>
        {/* Left — key numbers */}
        <div className="flex w-52 flex-shrink-0 flex-col justify-around border-r border-border px-4 py-3">
          <div>
            <div className="text-label">Terrain Elevation</div>
            <div className="text-metric text-xl">
              {Math.round(elevation_m).toLocaleString()} m
            </div>
            <div className="text-metric text-[11px] text-muted-foreground">
              {Math.round(elevation_ft).toLocaleString()} ft
            </div>
          </div>
          <div>
            <div className="text-label">Min Safe Altitude</div>
            <div className="text-metric-accent text-xl">
              {Math.round(msa_ft).toLocaleString()} ft
            </div>
          </div>
          <div className="flex items-end gap-4">
            <div>
              <div className="text-label">Sector</div>
              <div className="text-metric-accent">{sectorLabel}</div>
            </div>
            {ttci != null && (
              <div>
                <div className="text-label">TTCI</div>
                <div className="text-metric font-semibold" style={{ color: ttciColor }}>
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
              "w-full rounded border-2 px-2 py-2.5 text-center",
              clearStatus === "WARNING" && "animate-pulse border-risk-high/70 bg-risk-high/12",
              clearStatus === "CAUTION" && "border-risk-moderate/50 bg-risk-moderate/8",
              clearStatus === "CLEAR"   && "border-risk-vlow/40 bg-risk-vlow/6",
            )}
          >
            <div className="text-label">Clearance</div>
            <div className="text-metric-lg text-4xl font-bold" style={{ color: clearColor }}>
              {Math.round(clearance_ft).toLocaleString()}
            </div>
            <div className="text-metric text-[10px] text-muted-foreground">ft</div>
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

/** Full-screen red pulse overlay when terrain clearance drops to WARNING. */
function WarningOverlay() {
  const { flyPosition } = useTools();
  if (!flyPosition || flyPosition.clearance_ft >= MSA_CLEARANCE_WARNING_FT) return null;

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

export function MapView() {
  const { status, activeRegion, overlayVersion, activate, toast } = useTtci();
  const { mode, setMode, view, setView, overlayOpacity, showOverlay, demSource, setDemSource } = useTools();
  const onAreaRef = useRef<(b: Bounds) => void>(() => {});

  onAreaRef.current = async (b: Bounds) => {
    setMode("idle");
    if (spanTooLarge(b)) {
      toast(spanErrorMessage(b), "error");
      return;
    }
    try { await activate(b, demSource); } catch { /* handled */ }
  };

  const showPrompt =
    !activeRegion && status !== "computing" && mode !== "draw-area";

  return (
    <div className="relative h-full w-full">
      <MapContainer center={[25, 82]} zoom={3} className="h-full w-full" zoomControl={false} attributionControl>
        <ZoomControl position="topright" />
        <TileLayer
          url={TILE_URL}
          subdomains="abcd"
          attribution="&copy; OpenStreetMap &copy; CARTO"
          maxZoom={18}
        />
        {activeRegion && showOverlay && (
          <ImageOverlay
            key={overlayVersion}
            url={`/api/ttci/overlay.png?v=${overlayVersion}`}
            bounds={[[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]]}
            opacity={overlayOpacity}
          />
        )}
        <FitToRegion />
        <PrepareDrawArea />
        <ClickLayer />
        <DrawController onArea={(b) => onAreaRef.current(b)} />
        <MsaLayers />
        <FlyRouteLayers />
        <TawsLayers />
        <CfitLayers />
      </MapContainer>

      <MapModeBanner />
      <CockpitStrip />

      {/* WARNING overlay — full-screen red pulse when dangerously close to terrain */}
      <WarningOverlay />

      {/* Risk legend — z-700, visible above both Leaflet and Cesium (z-600) */}
      <RiskLegend />

      {/* Map / Globe view toggle — bottom-right corner, unobtrusive */}
      <button
        onClick={() => setView(view === "2d" ? "3d" : "2d")}
        className="absolute bottom-7 right-3 z-[700] panel-float px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      >
        {view === "3d" ? "2D Map" : "3D Globe"}
      </button>

      <button
        onClick={() => {
          setMode("draw-area");
          toast("Drag a box on the map to select the area to assess.", "info");
        }}
        className="absolute left-3 top-3 z-[700] flex items-center gap-2 panel-float px-3.5 py-2 text-xs font-semibold transition-colors hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" /> Select area
      </button>

      {showPrompt && (
        <div className="absolute inset-0 z-[680] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-[min(460px,calc(100%-48px))] panel p-8 text-center">
            <h2 className="text-title mb-3 text-lg">
              Where do you want to analyze?
            </h2>
            <p className="text-hint mb-6">
              Draw a region on the map or jump to a preset mountain area.
            </p>
            <div className="mb-4 flex items-center justify-center gap-2">
              <Button onClick={() => { setMode("draw-area"); toast("Drag a box on the map.", "info"); }}>
                <Pencil className="h-4 w-4" /> Draw on map
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                DEM
                <select
                  value={demSource}
                  onChange={(e) => setDemSource(e.target.value)}
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
                  onClick={() => activate(p.bbox, demSource).catch(() => {})}
                  className="rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {status === "computing" && (
        <div className="absolute inset-0 z-[690] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="panel flex flex-col items-center gap-3 px-8 py-6">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-foreground" />
            <span className="text-body-sm">Computing TTCI for the selected area…</span>
          </div>
        </div>
      )}
    </div>
  );
}
