import { createContext, useContext, useState } from "react";
import type { MsaSector, ProfilePoint, TawsLookahead, Validation } from "@/lib/api";

export type ToolMode = "idle" | "draw-area" | "draw-route" | "place-aircraft";
export type ViewMode = "2d" | "3d";

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
  view: ViewMode;
  setView: (v: ViewMode) => void;

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

  // CFIT
  validation: Validation | null;
  setValidation: (v: Validation | null) => void;
  cfitShown: boolean;
  setCfitShown: (b: boolean) => void;

  // Layers
  overlayOpacity: number;
  setOverlayOpacity: (n: number) => void;
  showOverlay: boolean;
  setShowOverlay: (b: boolean) => void;
}

const Ctx = createContext<ToolsState | null>(null);

export function ToolsProvider({ children }: { children: React.ReactNode }) {
  const [mode, _setMode] = useState<ToolMode>("idle");
  const [view, setView] = useState<ViewMode>("3d");

  // Interactive modes require the 2D map — auto-switch when activated.
  const setMode = (m: ToolMode) => {
    if (m === "draw-route" || m === "draw-area" || m === "place-aircraft") {
      setView("2d");
    }
    _setMode(m);
  };
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
  const [cfitShown, setCfitShown] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.72);
  const [showOverlay, setShowOverlay] = useState(true);

  const value: ToolsState = {
    mode, setMode, view, setView,
    routeWaypoints, setRouteWaypoints, msaSectors, setMsaSectors, msaProfile, setMsaProfile,
    flyPosition, setFlyPosition,
    aircraft, setAircraft, tawsParams, setTawsParams, tawsResult, setTawsResult,
    validation, setValidation, cfitShown, setCfitShown,
    overlayOpacity, setOverlayOpacity, showOverlay, setShowOverlay,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTools() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTools must be used within ToolsProvider");
  return ctx;
}
