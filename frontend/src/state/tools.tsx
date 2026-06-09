import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { MsaSector, ProfilePoint, TawsLookahead, Validation, CorridorResult, UasPlanRouteResult } from "@/lib/api";

export type ToolMode =
  | "idle"
  | "draw-area"
  | "draw-route"
  | "draw-corridor"
  | "plan-uas-route"
  | "place-aircraft"
  | "place-history-pin";

export interface HistoryItem {
  id: string;
  /** "pin" and "note" are user-created; "assessment" is an auto-logged analysis result. */
  kind: "pin" | "note" | "assessment";
  lat: number | null;
  lon: number | null;
  title: string;
  body: string;
  createdAt: number;
  // Assessment-only fields:
  assessmentKind?: AssessmentKind;
  lines?: string[];
  riskColor?: string;
}

export type AssessmentKind = "point" | "route" | "taws" | "uas-corridor" | "uas-route";

/** A single analysis result to record in the assessment log. */
export interface AssessmentRecord {
  kind: AssessmentKind;
  title: string;
  lines: string[];
  riskColor?: string;
  lat?: number | null;
  lon?: number | null;
}

export interface CorridorSegment {
  segIdx: number;
  from: [number, number];
  to: [number, number];
  distKm: number;
  result: CorridorResult;
}
export type ViewMode = "2d" | "3d";

export interface MapFocus { lat: number; lon: number; zoom: number }

type GlobeViewGetter = (() => { lat: number; lon: number; zoom: number } | null) | null;
type MapViewGetter = (() => MapFocus | null) | null;

export interface Aircraft { lat: number; lon: number }
export interface TawsParams {
  altitude_ft: number; heading_deg: number; ground_speed_kt: number; vertical_speed_fpm: number;
}

export interface FlyPosition {
  lat: number;
  lon: number;
  elevation_m: number;
  distance_km: number;
  totalDistance_km: number;
  msa_ft: number;
  msa_m: number;
  clearance_ft: number;
  sectorLabel: string;
  progressPct: number;
  ttci: number | null;
  heading_deg: number;
}

interface ToolsState {
  mode: ToolMode;
  setMode: (m: ToolMode) => void;
  beginDrawArea: () => void;
  toggleDrawArea: () => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  pendingMapFocus: MapFocus | null;
  consumeMapFocus: () => void;
  registerGlobeViewGetter: (getter: GlobeViewGetter) => void;
  registerMapViewGetter: (getter: MapViewGetter) => void;
  consumeGlobeFocus: () => MapFocus | null;

  // MSA
  routeWaypoints: [number, number][];
  setRouteWaypoints: (w: [number, number][]) => void;
  msaSectors: MsaSector[];
  setMsaSectors: (s: MsaSector[]) => void;
  msaProfile: ProfilePoint[];
  setMsaProfile: (p: ProfilePoint[]) => void;
  flyPosition: FlyPosition | null;
  setFlyPosition: (p: FlyPosition | null) => void;

  // TAWS
  aircraft: Aircraft | null;
  setAircraft: (a: Aircraft | null) => void;
  tawsParams: TawsParams;
  setTawsParams: (p: TawsParams) => void;
  tawsResult: TawsLookahead | null;
  setTawsResult: (r: TawsLookahead | null) => void;

  // UAS Corridor
  corridorWaypoints: [number, number][];
  setCorridorWaypoints: (w: [number, number][]) => void;
  corridorSegments: CorridorSegment[] | null;
  setCorridorSegments: (s: CorridorSegment[] | null) => void;

  // UAS route planner
  uasPlanStart: [number, number] | null;
  setUasPlanStart: (p: [number, number] | null) => void;
  uasPlanEnd: [number, number] | null;
  setUasPlanEnd: (p: [number, number] | null) => void;
  uasPickTarget: "start" | "end";
  setUasPickTarget: (t: "start" | "end") => void;
  uasPlannedPath: [number, number][] | null;
  setUasPlannedPath: (p: [number, number][] | null) => void;
  uasPlanResult: UasPlanRouteResult | null;
  setUasPlanResult: (r: UasPlanRouteResult | null) => void;

  // CFIT
  validation: Validation | null;
  setValidation: (v: Validation | null) => void;
  cfitShown: boolean;
  setCfitShown: (b: boolean) => void;

  // Display & map
  overlayOpacity: number;
  setOverlayOpacity: (n: number) => void;
  showOverlay: boolean;
  setShowOverlay: (b: boolean) => void;
  demSource: string;
  setDemSource: (s: string) => void;
  globeExaggeration: number;
  setGlobeExaggeration: (n: number) => void;

  showMsaTab: boolean;
  setShowMsaTab: (b: boolean) => void;
  showTawsTab: boolean;
  setShowTawsTab: (b: boolean) => void;
  showUasTab: boolean;
  setShowUasTab: (b: boolean) => void;

  /** Offline / lightweight mode: hide the 3D globe entirely and never load Cesium. */
  disable3D: boolean;
  setDisable3D: (b: boolean) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (b: boolean) => void;

  historyItems: HistoryItem[];
  selectedHistoryId: string | null;
  setSelectedHistoryId: (id: string | null) => void;
  addHistoryPin: (lat: number, lon: number, title?: string) => string;
  addHistoryNote: (title?: string, body?: string) => string;
  logAssessment: (rec: AssessmentRecord) => void;
  clearAssessmentLog: () => void;
  updateHistoryItem: (id: string, patch: Partial<Pick<HistoryItem, "title" | "body" | "lat" | "lon">>) => void;
  removeHistoryItem: (id: string) => void;
  focusMap: (lat: number, lon: number, zoom?: number) => void;

  resetForNewRegion: () => void;
}

const HISTORY_KEY = "terrain-guard-history";
const MAX_ASSESSMENTS = 100;

function readHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    if (!Array.isArray(parsed)) return [];
    // Backfill `kind` for items saved before the assessment log existed.
    return parsed.map((h) => ({
      ...h,
      kind: h.kind ?? (h.lat != null ? "pin" : "note"),
    }));
  } catch {
    return [];
  }
}

function writeHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch { /* private browsing */ }
}

function newHistoryId(): string {
  return `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SETTINGS_KEY = "terrain-guard-settings";
const LEGACY_SIDEBAR_TOOLS_KEY = "terrain-guard-sidebar-tools";

interface PersistedSettings {
  view: ViewMode;
  showOverlay: boolean;
  overlayOpacity: number;
  cfitShown: boolean;
  globeExaggeration: number;
  demSource: string;
  showMsaTab: boolean;
  showTawsTab: boolean;
  showUasTab: boolean;
  sidebarOpen: boolean;
  disable3D: boolean;
}

const SETTINGS_DEFAULTS: PersistedSettings = {
  view: "2d",
  showOverlay: true,
  overlayOpacity: 0.72,
  cfitShown: false,
  globeExaggeration: 3,
  demSource: "tiles",
  showMsaTab: true,
  showTawsTab: true,
  showUasTab: true,
  sidebarOpen: true,
  disable3D: false,
};

function readPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedSettings>;
      return { ...SETTINGS_DEFAULTS, ...p };
    }
    const legacy = localStorage.getItem(LEGACY_SIDEBAR_TOOLS_KEY);
    if (legacy) {
      const p = JSON.parse(legacy) as Partial<Pick<PersistedSettings, "showMsaTab" | "showTawsTab" | "showUasTab">>;
      return {
        ...SETTINGS_DEFAULTS,
        showMsaTab: p.showMsaTab ?? true,
        showTawsTab: p.showTawsTab ?? true,
        showUasTab: p.showUasTab ?? true,
      };
    }
  } catch { /* private browsing */ }
  return SETTINGS_DEFAULTS;
}

function writePersistedSettings(s: PersistedSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* private browsing */ }
}

const Ctx = createContext<ToolsState | null>(null);

export function ToolsProvider({ children }: { children: React.ReactNode }) {
  const initial = readPersistedSettings();
  const [mode, _setMode] = useState<ToolMode>("idle");
  const [disable3D, _setDisable3D] = useState<boolean>(initial.disable3D);
  // Honour offline mode on first load: never start in a 3D view that we won't render.
  const [view, _setView] = useState<ViewMode>(initial.disable3D ? "2d" : initial.view);
  const [pendingMapFocus, setPendingMapFocus] = useState<MapFocus | null>(null);
  const globeViewGetterRef = useRef<GlobeViewGetter>(null);
  const mapViewGetterRef = useRef<MapViewGetter>(null);
  const pendingGlobeFocusRef = useRef<MapFocus | null>(null);
  const viewRef = useRef<ViewMode>(view);
  const disable3DRef = useRef<boolean>(disable3D);
  viewRef.current = view;
  disable3DRef.current = disable3D;

  const setMode = (m: ToolMode) => {
    if (
      m === "draw-route"
      || m === "draw-corridor"
      || m === "plan-uas-route"
      || m === "place-aircraft"
      || m === "place-history-pin"
    ) {
      setView("2d");
    }
    _setMode(m);
  };

  const registerGlobeViewGetter = useCallback((getter: GlobeViewGetter) => {
    globeViewGetterRef.current = getter;
  }, []);

  const registerMapViewGetter = useCallback((getter: MapViewGetter) => {
    mapViewGetterRef.current = getter;
  }, []);

  const consumeMapFocus = useCallback(() => setPendingMapFocus(null), []);

  const consumeGlobeFocus = useCallback((): MapFocus | null => {
    const pose = pendingGlobeFocusRef.current;
    pendingGlobeFocusRef.current = null;
    return pose;
  }, []);

  /**
   * Switch 2D ↔ 3D, syncing the camera in BOTH directions so the two views stay
   * aligned. When `capture` is true (the default) and the view actually changes,
   * the source view's current pose is captured and handed to the destination
   * view: map center/zoom → globe on 2D→3D, and globe center/zoom → map on
   * 3D→2D. Callers that set their own focus target (focusMap, beginDrawArea)
   * pass `capture = false` so they are not clobbered.
   *
   * In offline mode (`disable3D`) a request for "3d" is coerced to "2d" so the
   * unrendered globe is never made the active view.
   */
  const changeView = useCallback((v: ViewMode, capture = true) => {
    let target = v;
    if (disable3DRef.current && target === "3d") target = "2d";
    const changed = target !== viewRef.current;
    if (capture && changed) {
      if (target === "3d") {
        const pose = mapViewGetterRef.current?.();
        if (pose) pendingGlobeFocusRef.current = pose;
      } else {
        const pose = globeViewGetterRef.current?.();
        // Only carry the globe location over when it is zoomed into a specific
        // area (zoom >= 8). From a wide/global view, leave the 2D map at its full
        // world view so the user can select any region instead of jumping to the
        // globe's center point (lat 0, lon 0 — which lands on Africa).
        if (pose && pose.zoom >= 8) {
          setPendingMapFocus({ lat: pose.lat, lon: pose.lon, zoom: Math.round(pose.zoom) });
        }
      }
    }
    _setView(target);
  }, []);

  const setView = useCallback((v: ViewMode) => changeView(v), [changeView]);

  const setDisable3D = useCallback((off: boolean) => {
    _setDisable3D(off);
    // Leaving the user stranded on a hidden globe would freeze the app, so fall
    // back to the 2D map whenever 3D is turned off mid-session.
    if (off && viewRef.current === "3d") changeView("2d");
  }, [changeView]);

  const beginDrawArea = useCallback(() => {
    // changeView captures the globe pose into the pending map focus on 3D→2D,
    // so the 2D map opens centered where the user was looking in 3D.
    changeView("2d");
    _setMode("draw-area");
  }, [changeView]);

  const toggleDrawArea = useCallback(() => {
    if (mode === "draw-area") {
      _setMode("idle");
      return;
    }
    beginDrawArea();
  }, [mode, beginDrawArea]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (mode !== "draw-area" && mode !== "place-history-pin") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      _setMode("idle");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  const [corridorWaypoints, setCorridorWaypoints] = useState<[number, number][]>([]);
  const [corridorSegments, setCorridorSegments] = useState<CorridorSegment[] | null>(null);
  const [uasPlanStart, setUasPlanStart] = useState<[number, number] | null>(null);
  const [uasPlanEnd, setUasPlanEnd] = useState<[number, number] | null>(null);
  const [uasPickTarget, setUasPickTarget] = useState<"start" | "end">("start");
  const [uasPlannedPath, setUasPlannedPath] = useState<[number, number][] | null>(null);
  const [uasPlanResult, setUasPlanResult] = useState<UasPlanRouteResult | null>(null);
  const [routeWaypoints, setRouteWaypoints] = useState<[number, number][]>([]);
  const [msaSectors, setMsaSectors] = useState<MsaSector[]>([]);
  const [msaProfile, setMsaProfile] = useState<ProfilePoint[]>([]);
  const [flyPosition, setFlyPosition] = useState<FlyPosition | null>(null);
  const [aircraft, setAircraft] = useState<Aircraft | null>(null);
  const [tawsParams, setTawsParams] = useState<TawsParams>({
    altitude_ft: 13000, heading_deg: 90, ground_speed_kt: 280, vertical_speed_fpm: 0,
  });
  const [tawsResult, setTawsResult] = useState<TawsLookahead | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [cfitShown, setCfitShown] = useState(initial.cfitShown);
  const [overlayOpacity, setOverlayOpacity] = useState(initial.overlayOpacity);
  const [showOverlay, setShowOverlay] = useState(initial.showOverlay);
  const [demSource, setDemSource] = useState(initial.demSource);
  const [globeExaggeration, setGlobeExaggeration] = useState(initial.globeExaggeration);
  const [showMsaTab, _setShowMsaTab] = useState(initial.showMsaTab);
  const [showTawsTab, _setShowTawsTab] = useState(initial.showTawsTab);
  const [showUasTab, _setShowUasTab] = useState(initial.showUasTab);
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>(() => readHistory());
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const lastAssessmentRef = useRef<{ sig: string; t: number } | null>(null);

  const setShowMsaTab = useCallback((on: boolean) => {
    _setShowMsaTab(on);
    if (!on) {
      if (mode === "draw-route") _setMode("idle");
      setFlyPosition(null);
    }
  }, [mode]);

  const setShowTawsTab = useCallback((on: boolean) => {
    _setShowTawsTab(on);
    if (!on) {
      if (mode === "place-aircraft") _setMode("idle");
      setAircraft(null);
      setTawsResult(null);
    }
  }, [mode]);

  const setShowUasTab = useCallback((on: boolean) => {
    _setShowUasTab(on);
    if (!on) {
      if (mode === "draw-corridor" || mode === "plan-uas-route") _setMode("idle");
      setCorridorWaypoints([]);
      setCorridorSegments(null);
      setUasPlanStart(null);
      setUasPlanEnd(null);
      setUasPlannedPath(null);
      setUasPlanResult(null);
    }
  }, [mode]);

  useEffect(() => {
    writePersistedSettings({
      view,
      showOverlay,
      overlayOpacity,
      cfitShown,
      globeExaggeration,
      demSource,
      showMsaTab,
      showTawsTab,
      showUasTab,
      sidebarOpen,
      disable3D,
    });
  }, [
    view, showOverlay, overlayOpacity, cfitShown, globeExaggeration, demSource,
    showMsaTab, showTawsTab, showUasTab, sidebarOpen, disable3D,
  ]);

  useEffect(() => {
    const id = window.setTimeout(() => writeHistory(historyItems), 400);
    return () => window.clearTimeout(id);
  }, [historyItems]);

  const focusMap = useCallback((lat: number, lon: number, zoom = 10) => {
    setPendingMapFocus({ lat, lon, zoom });
    // capture=false: this is an explicit focus target, don't overwrite it with
    // the globe pose when coming from 3D.
    changeView("2d", false);
  }, [changeView]);

  const addHistoryPin = useCallback((lat: number, lon: number, title?: string) => {
    const pinCount = historyItems.filter((h) => h.kind === "pin").length;
    const id = newHistoryId();
    const item: HistoryItem = {
      id,
      kind: "pin",
      lat,
      lon,
      title: title?.trim() || `Pin ${pinCount + 1}`,
      body: "",
      createdAt: Date.now(),
    };
    setHistoryItems((prev) => [item, ...prev]);
    setSelectedHistoryId(id);
    return id;
  }, [historyItems]);

  const addHistoryNote = useCallback((title?: string, body?: string) => {
    const noteCount = historyItems.filter((h) => h.kind === "note").length;
    const id = newHistoryId();
    const item: HistoryItem = {
      id,
      kind: "note",
      lat: null,
      lon: null,
      title: title?.trim() || `Note ${noteCount + 1}`,
      body: body ?? "",
      createdAt: Date.now(),
    };
    setHistoryItems((prev) => [item, ...prev]);
    setSelectedHistoryId(id);
    return id;
  }, [historyItems]);

  // Record an analysis result in the assessment log. Identical back-to-back
  // results (e.g. re-clicking the same cell) are de-duplicated, and the log is
  // capped so it can't grow without bound in localStorage.
  const logAssessment = useCallback((rec: AssessmentRecord) => {
    const sig = `${rec.kind}|${rec.title}|${rec.lines.join("|")}`;
    const now = Date.now();
    const last = lastAssessmentRef.current;
    if (last && last.sig === sig && now - last.t < 2000) return;
    lastAssessmentRef.current = { sig, t: now };

    const item: HistoryItem = {
      id: newHistoryId(),
      kind: "assessment",
      assessmentKind: rec.kind,
      lat: rec.lat ?? null,
      lon: rec.lon ?? null,
      title: rec.title,
      body: "",
      lines: rec.lines,
      riskColor: rec.riskColor,
      createdAt: now,
    };
    setHistoryItems((prev) => {
      let kept = 0;
      const next = [item, ...prev].filter((h) => {
        if (h.kind !== "assessment") return true;
        kept += 1;
        return kept <= MAX_ASSESSMENTS;
      });
      return next;
    });
  }, []);

  const clearAssessmentLog = useCallback(() => {
    setHistoryItems((prev) => prev.filter((h) => h.kind !== "assessment"));
  }, []);

  const updateHistoryItem = useCallback((
    id: string,
    patch: Partial<Pick<HistoryItem, "title" | "body" | "lat" | "lon">>,
  ) => {
    setHistoryItems((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  }, []);

  const removeHistoryItem = useCallback((id: string) => {
    setHistoryItems((prev) => prev.filter((h) => h.id !== id));
    setSelectedHistoryId((cur) => (cur === id ? null : cur));
  }, []);

  const resetForNewRegion = useCallback(() => {
    _setMode("idle");
    setCorridorWaypoints([]);
    setCorridorSegments(null);
    setUasPlanStart(null);
    setUasPlanEnd(null);
    setUasPlannedPath(null);
    setUasPlanResult(null);
    setRouteWaypoints([]);
    setMsaSectors([]);
    setMsaProfile([]);
    setFlyPosition(null);
    setAircraft(null);
    setTawsResult(null);
    setCfitShown(false);
  }, []);

  const value: ToolsState = {
    mode, setMode, beginDrawArea, toggleDrawArea, view, setView,
    pendingMapFocus, consumeMapFocus, registerGlobeViewGetter, registerMapViewGetter, consumeGlobeFocus,
    corridorWaypoints, setCorridorWaypoints, corridorSegments, setCorridorSegments,
    uasPlanStart, setUasPlanStart, uasPlanEnd, setUasPlanEnd,
    uasPickTarget, setUasPickTarget, uasPlannedPath, setUasPlannedPath,
    uasPlanResult, setUasPlanResult,
    routeWaypoints, setRouteWaypoints, msaSectors, setMsaSectors, msaProfile, setMsaProfile,
    flyPosition, setFlyPosition,
    aircraft, setAircraft, tawsParams, setTawsParams, tawsResult, setTawsResult,
    validation, setValidation, cfitShown, setCfitShown,
    overlayOpacity, setOverlayOpacity, showOverlay, setShowOverlay,
    demSource, setDemSource, globeExaggeration, setGlobeExaggeration,
    showMsaTab, setShowMsaTab, showTawsTab, setShowTawsTab, showUasTab, setShowUasTab,
    disable3D, setDisable3D,
    sidebarOpen, setSidebarOpen,
    historyItems, selectedHistoryId, setSelectedHistoryId,
    addHistoryPin, addHistoryNote, logAssessment, clearAssessmentLog,
    updateHistoryItem, removeHistoryItem, focusMap,
    resetForNewRegion,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTools() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTools must be used within ToolsProvider");
  return ctx;
}
