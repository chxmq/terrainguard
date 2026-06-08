import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  MapContainer, TileLayer, ImageOverlay, CircleMarker, Marker, Polyline, Rectangle, Popup, Tooltip,
  ZoomControl, useMap, useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet-draw";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
import { Pencil } from "lucide-react";
import { api, type Bounds } from "@/lib/api";
import { useTtci, riskColor } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { MsaProfileChart } from "@/components/charts";
import { cn, fmt, fmtInt } from "@/lib/utils";
import { formatApiError, NOTIFY, regionTooLargeMessage } from "@/lib/notifications";

const TILE_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_URL_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const BUF_DEG = 0.0834;
const MAX_REGION_SPAN_DEG = 12;
const WORLD_BOUNDS = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
const WORLD_CENTER: [number, number] = [0, 0];
const WORLD_ZOOM = 2;

function frameMinZoom(map: L.Map): number {
  return map.getBoundsZoom(WORLD_BOUNDS, false);
}

function clampMapToFrame(map: L.Map) {
  const minZoom = frameMinZoom(map);
  map.setMinZoom(minZoom);
  if (map.getZoom() < minZoom) {
    map.setZoom(minZoom, { animate: false });
  }
  map.panInsideBounds(WORLD_BOUNDS, { animate: false });
}

/** Persists across MapView remounts (2D ↔ 3D) so reopening 2D does not re-zoom. */
let fittedRegionKey: string | null = null;

const MODE_HINTS: Record<string, string> = {
  "draw-area": "Drag a box around the terrain you want to analyze · Esc to cancel",
  "draw-route": "Click on the map to place waypoints · double-click to finish",
  "draw-corridor": "Click to place UAS corridor waypoints · double-click to finish",
  "place-aircraft": "Click the map to place the aircraft",
  "place-history-pin": "Click the map to drop a history pin · Esc to cancel",
};

function spanTooLarge(b: Bounds): boolean {
  return (b.north - b.south) > MAX_REGION_SPAN_DEG || (b.east - b.west) > MAX_REGION_SPAN_DEG;
}

function spanErrorMessage(b: Bounds): string {
  return regionTooLargeMessage(b.north - b.south, b.east - b.west, MAX_REGION_SPAN_DEG);
}

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

function InvalidateOnLayout() {
  const map = useMap();
  const { sidebarOpen } = useTools();
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize(), 220);
    return () => window.clearTimeout(id);
  }, [sidebarOpen, map]);
  return null;
}

/** Exposes live Leaflet center/zoom so 2D → 3D can fly the globe to the same view. */
function MapViewPoseRegistrar() {
  const map = useMap();
  const { registerMapViewGetter } = useTools();

  useEffect(() => {
    registerMapViewGetter(() => {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
    });
    return () => registerMapViewGetter(null);
  }, [map, registerMapViewGetter]);

  return null;
}

function LockWorldBounds() {
  const map = useMap();
  const { sidebarOpen } = useTools();
  useEffect(() => {
    const apply = () => {
      map.setMaxBounds(WORLD_BOUNDS);
      map.options.maxBoundsViscosity = 1;
      clampMapToFrame(map);
    };
    apply();
    map.on("resize", apply);
    map.on("zoomend", apply);
    map.on("moveend", apply);
    return () => {
      map.off("resize", apply);
      map.off("zoomend", apply);
      map.off("moveend", apply);
    };
  }, [map, sidebarOpen]);
  return null;
}

function ApplyMapFocus() {
  const map = useMap();
  const { pendingMapFocus, consumeMapFocus } = useTools();
  useEffect(() => {
    if (!pendingMapFocus) return;
    map.setView(
      [pendingMapFocus.lat, pendingMapFocus.lon],
      Math.max(pendingMapFocus.zoom, map.getMinZoom()),
      { animate: false },
    );
    consumeMapFocus();
  }, [pendingMapFocus, map, consumeMapFocus]);
  return null;
}

/** Zoom to a newly activated region only — not when reopening the 2D map. */
function FitToRegion() {
  const { activeRegion } = useTtci();
  const map = useMap();
  useEffect(() => {
    if (!activeRegion) {
      fittedRegionKey = null;
      return;
    }
    const key = `${activeRegion.south},${activeRegion.north},${activeRegion.west},${activeRegion.east},${activeRegion.zoom}`;
    if (fittedRegionKey === key) return;
    fittedRegionKey = key;
    map.fitBounds(
      [[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]],
      { padding: [24, 24] },
    );
    window.requestAnimationFrame(() => clampMapToFrame(map));
  }, [activeRegion, map]);
  return null;
}

function TileLayerThemed() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return (
    <TileLayer
      url={dark ? TILE_URL_DARK : TILE_URL_LIGHT}
      subdomains="abcd"
      attribution="&copy; OpenStreetMap &copy; CARTO"
      maxZoom={18}
      noWrap
    />
  );
}

function ClickLayer() {
  const { activeRegion, setLastQuery, lastQuery, toast } = useTtci();
  const { mode, setMode, setAircraft, showTawsTab, addHistoryPin } = useTools();
  useMapEvents({
    click: async (e) => {
      if (mode === "place-history-pin") {
        addHistoryPin(e.latlng.lat, e.latlng.lng);
        setMode("idle");
        return;
      }
      if (mode === "place-aircraft" && showTawsTab) {
        setAircraft({ lat: e.latlng.lat, lon: e.latlng.lng });
        setMode("idle");
        return;
      }
      if (mode !== "idle" || !activeRegion) return;
      try {
        setLastQuery(await api.query(e.latlng.lat, e.latlng.lng));
      } catch (err) {
        toast(formatApiError(err, NOTIFY.pointQueryFailed), "error");
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

function drawVertexIcon(accent: string) {
  return L.divIcon({
    className: "tg-draw-vertex",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: `<span class="tg-draw-vertex-dot" style="--tg-vertex:${accent}"></span>`,
  });
}

function DrawController({ onArea }: { onArea: (b: Bounds) => void }) {
  const map = useMap();
  const { toast, status } = useTtci();
  const { mode, setMode, setRouteWaypoints, setCorridorWaypoints, showMsaTab, showUasTab } = useTools();
  useEffect(() => {
    if (status === "computing") return;
    if (mode === "draw-route" && !showMsaTab) return;
    if (mode === "draw-corridor" && !showUasTab) return;
    if (mode !== "draw-area" && mode !== "draw-route" && mode !== "draw-corridor") return;
    const LD = (L as any).Draw;
    const areaIcon = drawVertexIcon("#06b6d4");
    const routeIcon = drawVertexIcon("#3b82f6");
    const corridorIcon = drawVertexIcon("#a855f7");
    const handler =
      mode === "draw-area"
        ? new LD.Rectangle(map, {
            showArea: false,
            icon: areaIcon,
            touchIcon: areaIcon,
            shapeOptions: { color: "#06b6d4", weight: 2, fillColor: "#06b6d4", fillOpacity: 0.05 },
          })
        : new LD.Polyline(map, {
            showLength: false,
            icon: mode === "draw-corridor" ? corridorIcon : routeIcon,
            touchIcon: mode === "draw-corridor" ? corridorIcon : routeIcon,
            shapeOptions: {
              color: mode === "draw-corridor" ? "#a855f7" : "#3b82f6",
              weight: 3,
              dashArray: "8,6",
            },
            maxPoints: 50,
          });
    handler.enable();
    const onCreated = (e: any) => {
      if (mode === "draw-area") {
        const b = e.layer.getBounds();
        const bbox = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
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
        if (mode === "draw-corridor") setCorridorWaypoints(wps);
        else setRouteWaypoints(wps);
        setMode("idle");
      }
    };
    map.on((L as any).Draw.Event.CREATED, onCreated);
    return () => {
      map.off((L as any).Draw.Event.CREATED, onCreated);
      try { handler.disable(); } catch { /* noop */ }
    };
  }, [mode, map, onArea, setMode, setRouteWaypoints, setCorridorWaypoints, toast, showMsaTab, showUasTab, status]);
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

function CorridorLayers() {
  const { corridorWaypoints, corridorSegments } = useTools();

  const wpMarkers = corridorWaypoints.map(([la, lo], i) => (
    <CircleMarker
      key={`cw${i}`}
      center={[la, lo]}
      radius={5}
      pathOptions={{ color: "#7c3aed", weight: 2, fillColor: "#a855f7", fillOpacity: 1 }}
    >
      <Tooltip direction="top">{i + 1}</Tooltip>
    </CircleMarker>
  ));

  if (corridorSegments && corridorSegments.length > 0) {
    return (
      <>
        {corridorSegments.map((seg) => (
          <Polyline
            key={`cors${seg.segIdx}`}
            positions={[seg.from, seg.to]}
            pathOptions={{ color: seg.result.dominant_risk_color, weight: 6, opacity: 0.88, lineCap: "round" }}
          >
            <Popup>
              <div className="font-sans text-xs">
                <div className="font-semibold">Segment {seg.segIdx + 1}</div>
                <div>Risk: <strong style={{ color: seg.result.dominant_risk_color }}>{seg.result.dominant_risk_level}</strong></div>
                <div>TTCI: {seg.result.ttci.mean.toFixed(3)}</div>
                <div>Length: {seg.distKm.toFixed(1)} km</div>
              </div>
            </Popup>
          </Polyline>
        ))}
        {wpMarkers}
      </>
    );
  }

  if (corridorWaypoints.length < 2) return null;

  return (
    <>
      <Polyline
        positions={corridorWaypoints.map(([la, lo]) => [la, lo])}
        pathOptions={{ color: "#a855f7", weight: 4, dashArray: "10,8", opacity: 0.9 }}
      />
      {wpMarkers}
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

function HistoryLayers() {
  const { historyItems, selectedHistoryId, setSelectedHistoryId } = useTools();

  return (
    <>
      {historyItems.map((item) => {
        if (item.lat == null || item.lon == null) return null;
        const selected = selectedHistoryId === item.id;
        return (
          <CircleMarker
            key={item.id}
            center={[item.lat, item.lon]}
            radius={selected ? 9 : 7}
            pathOptions={{
              color: "#fff",
              weight: selected ? 3 : 2,
              fillColor: selected ? "#38bdf8" : "#f59e0b",
              fillOpacity: 1,
            }}
            eventHandlers={{ click: () => setSelectedHistoryId(item.id) }}
          >
            <Popup>
              <div className="font-sans text-xs">
                <div className="font-semibold">{item.title}</div>
                {item.body && <div className="mt-1 text-muted-foreground">{item.body}</div>}
                <div className="mt-1 tabular-nums text-[10px] text-muted-foreground">
                  {fmt(item.lat, 4)}°, {fmt(item.lon, 4)}°
                </div>
              </div>
            </Popup>
            <Tooltip direction="top">{item.title}</Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

function aircraftIconHtml(heading_deg: number, fillColor: string, glowRgba: string) {
  return `
    <div style="position:relative;width:44px;height:44px">
      <div style="position:absolute;top:50%;left:50%;width:44px;height:44px;
        transform:translate(-50%,-50%);border-radius:50%;background:${glowRgba}"></div>
      <svg width="44" height="44" viewBox="-22 -22 44 44"
        style="position:absolute;top:0;left:0;transform:rotate(${heading_deg}deg)">
        <path d="M0,-16 L4,0 L16,7 L9,9 L3,3.5 L2,13 L5,14.5 L0,13.5 L-5,14.5 L-2,13 L-3,3.5 L-9,9 L-16,7 L-4,0 Z"
          fill="${fillColor}" stroke="rgba(255,255,255,0.95)" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

/** Imperative marker — updates position without rebuilding icon every tick. */
function FlyAircraftMarker({
  lat, lon, heading_deg, fillColor,
}: {
  lat: number; lon: number; heading_deg: number; fillColor: string;
}) {
  const map = useMap();
  const markerRef = useRef<L.Marker | null>(null);
  const styleKeyRef = useRef("");

  const glowAlpha = fillColor === "#e74c3c" ? "0.55" : fillColor === "#e67e22" ? "0.4" : "0.35";
  const hex = fillColor.replace("#", "");
  const glowRgba = `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${glowAlpha})`;
  const styleKey = `${heading_deg}|${fillColor}`;

  useEffect(() => {
    if (!markerRef.current) {
      const icon = L.divIcon({
        html: aircraftIconHtml(heading_deg, fillColor, glowRgba),
        className: "",
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      });
      markerRef.current = L.marker([lat, lon], { icon }).addTo(map);
      styleKeyRef.current = styleKey;
    } else {
      markerRef.current.setLatLng([lat, lon]);
      if (styleKeyRef.current !== styleKey) {
        markerRef.current.setIcon(L.divIcon({
          html: aircraftIconHtml(heading_deg, fillColor, glowRgba),
          className: "",
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }));
        styleKeyRef.current = styleKey;
      }
    }
  }, [lat, lon, heading_deg, fillColor, glowRgba, styleKey, map]);

  useEffect(() => () => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, [map]);

  return null;
}

/** Animated rotated aircraft icon following the Fly Route simulation. */
function FlyRouteLayers() {
  const { flyPosition } = useTools();
  if (!flyPosition) return null;

  const { clearance_ft, heading_deg, lat, lon } = flyPosition;
  const fillColor =
    clearance_ft < 1500 ? "#e74c3c"
    : clearance_ft < 3000 ? "#e67e22"
    : "#2ecc71";

  return (
    <FlyAircraftMarker
      lat={lat}
      lon={lon}
      heading_deg={heading_deg}
      fillColor={fillColor}
    />
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
  const { status, activeRegion, overlayVersion, activate } = useTtci();
  const {
    mode, setMode, toggleDrawArea, view, setView,
    overlayOpacity, showOverlay, demSource,
    showMsaTab, showTawsTab, showUasTab,
  } = useTools();
  const drawingArea = mode === "draw-area";
  const onAreaRef = useRef<(b: Bounds) => void>(() => {});

  const computing = status === "computing";
  const { step, done } = useComputeProgress(computing);
  const overlayUrl = useMemo(
    () => api.overlayUrl(overlayVersion),
    [overlayVersion],
  );

  onAreaRef.current = async (b: Bounds) => {
    setMode("idle");
    try { await activate(b, demSource); } catch { /* surfaced via activate */ }
  };

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={WORLD_CENTER}
        zoom={WORLD_ZOOM}
        className="h-full w-full overflow-hidden"
        zoomControl={false}
        attributionControl
        maxBounds={WORLD_BOUNDS}
        maxBoundsViscosity={1}
        worldCopyJump={false}
      >
        <ZoomControl position="topright" />
        <InvalidateOnLayout />
        <MapViewPoseRegistrar />
        <LockWorldBounds />
        <TileLayerThemed />
        {activeRegion && showOverlay && (
          <ImageOverlay
            key={overlayVersion}
            url={overlayUrl}
            bounds={[[activeRegion.south, activeRegion.west], [activeRegion.north, activeRegion.east]]}
            opacity={overlayOpacity}
          />
        )}
        <FitToRegion />
        <ApplyMapFocus />
        <ClickLayer />
        <DrawController onArea={(b) => onAreaRef.current(b)} />
        {showMsaTab && <MsaLayers />}
        {showUasTab && <CorridorLayers />}
        {showMsaTab && <FlyRouteLayers />}
        {showTawsTab && <TawsLayers />}
        <HistoryLayers />
        <CfitLayers />
      </MapContainer>

      <MapModeBanner />
      {showMsaTab && <PilotHUD />}
      {showMsaTab && <CockpitStrip />}
      {showMsaTab && <WarningOverlay />}

      {/* Risk legend */}
      <RiskLegend />

      {/* Map / Globe view toggle */}
      <button
        onClick={() => setView(view === "2d" ? "3d" : "2d")}
        className="absolute bottom-7 right-3 z-[700] rounded border border-border bg-card/90 px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-muted-foreground shadow backdrop-blur transition-colors hover:border-foreground/25 hover:text-foreground"
      >
        {view === "3d" ? "2D Map" : "3D Globe"}
      </button>

      <button
        type="button"
        aria-pressed={drawingArea}
        disabled={computing}
        onClick={toggleDrawArea}
        className={cn(
          "absolute left-3 top-3 z-[700] flex items-center gap-2 panel-float px-3.5 py-2 text-xs font-semibold transition-all",
          computing && "cursor-not-allowed opacity-50",
          drawingArea
            ? "border-foreground/30 bg-foreground/10 text-foreground ring-2 ring-foreground/20"
            : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
        )}
      >
        <Pencil className={cn("h-3.5 w-3.5", drawingArea && "text-foreground")} />
        {drawingArea ? "Cancel selection" : "Select area"}
      </button>

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
                        ? "animate-pulse border-foreground/40 bg-foreground/10 text-foreground"
                        : "border-border bg-secondary",
                    )}
                  >
                    {done[i] ? "✓" : ""}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      done[i] ? "text-emerald-600 line-through" : i === step ? "font-semibold text-foreground" : "text-muted-foreground",
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
