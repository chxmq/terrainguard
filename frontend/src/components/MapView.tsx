import { useEffect, useRef, useState } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, CircleMarker, Polyline, Rectangle, Popup, Tooltip,
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
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { fmt, fmtInt } from "@/lib/utils";

const PRESETS: Array<{ name: string; bbox: Bounds }> = [
  { name: "Ladakh", bbox: { south: 33.8, north: 34.5, west: 76.8, east: 77.8 } },
  { name: "Mont Blanc", bbox: { south: 45.7, north: 46.1, west: 6.7, east: 7.3 } },
  { name: "Everest", bbox: { south: 27.8, north: 28.1, west: 86.7, east: 87.0 } },
  { name: "Andes (Cusco)", bbox: { south: -13.3, north: -13.0, west: -72.7, east: -72.4 } },
  { name: "Mt Rainier", bbox: { south: 46.7, north: 47.0, west: -121.9, east: -121.6 } },
];
const TILE = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};
const BUF_DEG = 0.0834; // ~5 NM half-width, matches backend

function FitToRegion() {
  const { activeRegion } = useTtci();
  const map = useMap();
  useEffect(() => {
    if (activeRegion)
      map.fitBounds([[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]], { padding: [24, 24] });
  }, [activeRegion, map]);
  return null;
}

/** Click → point query (idle) or aircraft placement (place-aircraft mode). */
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
            TTCI {fmt(lastQuery.ttci, 3)} <span style={{ color: lastQuery.risk_color }}>{lastQuery.risk_level}</span>
          </div>
          <div>Elevation: {fmt(lastQuery.elevation_m, 0)} m · {fmtInt(lastQuery.elevation_ft)} ft</div>
          <div>Slope: {fmt(lastQuery.metrics.slope_deg, 1)}° · TRI: {fmt(lastQuery.metrics.tri_m, 1)} m</div>
        </div>
      </Popup>
    </CircleMarker>
  );
}

/** Leaflet.draw controller for area (rectangle) and route (polyline). */
function DrawController({ onArea }: { onArea: (b: Bounds) => void }) {
  const map = useMap();
  const { mode, setMode, setRouteWaypoints } = useTools();
  useEffect(() => {
    if (mode !== "draw-area" && mode !== "draw-route") return;
    const LD = (L as any).Draw;
    const handler =
      mode === "draw-area"
        ? new LD.Rectangle(map, { shapeOptions: { color: "#06b6d4", weight: 2, fillColor: "#06b6d4", fillOpacity: 0.05 } })
        : new LD.Polyline(map, { shapeOptions: { color: "#3b82f6", weight: 3, dashArray: "8,6" }, maxPoints: 50 });
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
    return () => { map.off((L as any).Draw.Event.CREATED, onCreated); try { handler.disable(); } catch { /* noop */ } };
  }, [mode, map, onArea, setMode, setRouteWaypoints]);
  return null;
}

function MsaLayers() {
  const { riskLevels } = useTtci();
  const { routeWaypoints, msaSectors } = useTools();
  return (
    <>
      {routeWaypoints.length > 1 && (
        <Polyline positions={routeWaypoints.map(([la, lo]) => [la, lo])} pathOptions={{ color: "#3b82f6", weight: 3, dashArray: "8,6" }} />
      )}
      {routeWaypoints.map(([la, lo], i) => (
        <CircleMarker key={`wp${i}`} center={[la, lo]} radius={5} pathOptions={{ color: "#fff", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}>
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
          <Rectangle key={`sec${s.sector}`} bounds={bounds} pathOptions={{ color, fillColor: color, fillOpacity: 0.08, weight: 1, dashArray: "4,4" }}>
            <Popup>
              <div className="font-sans text-xs">
                <div className="font-bold">Sector {s.sector}</div>
                <div>MSA: {fmtInt(s.msa_ft)} ft · {fmtInt(s.msa_m)} m</div>
                <div>Max terrain: {fmtInt(s.max_terrain_ft)} ft</div>
              </div>
            </Popup>
          </Rectangle>
        );
      })}
    </>
  );
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
        <Polyline key={`seg${i}`} positions={[prev, [p.lat, p.lon]]} pathOptions={{ color: clearanceColor(p.clearance_ft, tawsResult.envelope), weight: 4, opacity: 0.9 }} />
      );
      prev = [p.lat, p.lon];
    });
  }
  return (
    <>
      {segs}
      <CircleMarker center={[aircraft.lat, aircraft.lon]} radius={7} pathOptions={{ color: "#fff", weight: 2, fillColor: "#3b82f6", fillOpacity: 1 }}>
        <Tooltip permanent direction="center">✈</Tooltip>
      </CircleMarker>
      {tawsResult?.trigger && (
        <CircleMarker center={[tawsResult.trigger.lat, tawsResult.trigger.lon]} radius={9} pathOptions={{ color: "#fff", weight: 2, fillColor: tawsResult.alert_color, fillOpacity: 0.95 }}>
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
        <CircleMarker key={a.flight} center={[a.lat, a.lon]} radius={7} pathOptions={{ color: "#fff", weight: 2, fillColor: a.risk_color, fillOpacity: 0.9 }}>
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

export function MapView() {
  const { theme } = useTheme();
  const { status, activeRegion, overlayVersion, activate, toast } = useTtci();
  const { mode, setMode, overlayOpacity, showOverlay } = useTools();
  const [source, setSource] = useState("tiles");
  const onAreaRef = useRef<(b: Bounds) => void>(() => {});

  onAreaRef.current = async (b: Bounds) => {
    setMode("idle");
    try { await activate(b, source); } catch { /* handled */ }
  };

  const showPrompt = status === "empty" || (!activeRegion && status !== "computing");

  return (
    <div className="relative h-full w-full">
      <MapContainer center={[25, 82]} zoom={3} className="h-full w-full" zoomControl attributionControl>
        <TileLayer url={theme === "dark" ? TILE.dark : TILE.light} subdomains="abcd" attribution="&copy; OpenStreetMap &copy; CARTO" maxZoom={18} />
        {activeRegion && showOverlay && (
          <ImageOverlay key={overlayVersion} url={api.overlayUrl()} bounds={[[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]]} opacity={overlayOpacity} />
        )}
        <FitToRegion />
        <ClickLayer />
        <DrawController onArea={(b) => onAreaRef.current(b)} />
        <MsaLayers />
        <TawsLayers />
        <CfitLayers />
      </MapContainer>

      <button
        onClick={() => { setMode("draw-area"); toast("Drag a box on the map to select the area to assess.", "info"); }}
        className="absolute left-3 top-3 z-[700] flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-2 text-xs font-semibold shadow-md backdrop-blur transition-colors hover:border-primary hover:text-primary"
      >
        <Pencil className="h-3.5 w-3.5" /> Select area
      </button>

      {showPrompt && (
        <div className="absolute inset-0 z-[680] flex items-center justify-center bg-background/55 backdrop-blur-sm">
          <div className="w-[min(460px,calc(100%-48px))] rounded-lg border border-border bg-card p-7 text-center shadow-lg">
            <h2 className="mb-2 bg-gradient-to-r from-primary to-risk-critical bg-clip-text text-xl font-extrabold text-transparent">Assess any terrain on Earth</h2>
            <p className="mb-5 text-sm text-muted-foreground">Draw a box on the map to compute the Terrain Topography Complexity Index for that area — or jump to a preset region.</p>
            <div className="mb-4 flex items-center justify-center gap-2">
              <Button onClick={() => { setMode("draw-area"); toast("Drag a box on the map to select the area.", "info"); }}>
                <Pencil className="h-4 w-4" /> Draw area on map
              </Button>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                DEM
                <select value={source} onChange={(e) => setSource(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                  <option value="tiles">SRTM 30 m</option>
                  <option value="copernicus">Copernicus GLO-30</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-muted-foreground">Presets:</span>
              {PRESETS.map((p) => (
                <button key={p.name} onClick={() => activate(p.bbox, source).catch(() => {})} className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary">
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {status === "computing" && (
        <div className="absolute inset-0 z-[690] flex items-center justify-center bg-background/70 backdrop-blur">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-muted border-t-primary" />
            <span className="text-sm text-muted-foreground">Computing TTCI for the selected area…</span>
          </div>
        </div>
      )}
    </div>
  );
}
