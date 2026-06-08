import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, type Bounds, type Info, type PointQuery, type RiskLevel } from "@/lib/api";

export type Status = "connecting" | "ready" | "computing" | "error" | "empty";
export interface ActiveRegion extends Bounds { zoom: number; source: string }

function demTypeToSource(demType?: string): string {
  if (demType === "copernicus30") return "copernicus";
  if (demType === "opentopo") return "opentopo";
  return "tiles";
}
export interface Toast { id: number; message: string; type: "info" | "success" | "error" }

interface TtciState {
  status: Status;
  statusText: string;
  info: Info | null;
  riskLevels: RiskLevel[];
  sourceLabel: string;
  isSynthetic: boolean;
  activeRegion: ActiveRegion | null;
  overlayVersion: number;          // bumps to force overlay reload
  lastQuery: PointQuery | null;
  toasts: Toast[];
  activate: (bbox: Bounds, source: string) => Promise<void>;
  setLastQuery: (q: PointQuery | null) => void;
  toast: (message: string, type?: Toast["type"]) => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<TtciState | null>(null);

export function TtciProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [statusText, setStatusText] = useState("Connecting…");
  const [info, setInfo] = useState<Info | null>(null);
  const [riskLevels, setRiskLevels] = useState<RiskLevel[]>([]);
  const [sourceLabel, setSourceLabel] = useState("");
  const [isSynthetic, setIsSynthetic] = useState(false);
  const [activeRegion, setActiveRegion] = useState<ActiveRegion | null>(null);
  const [overlayVersion, setOverlayVersion] = useState(0);
  const [lastQuery, setLastQuery] = useState<PointQuery | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((message: string, type: Toast["type"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const applyInfo = useCallback((i: Info) => {
    setInfo(i);
    setRiskLevels(i.risk_levels ?? []);
    setSourceLabel(i.source_label ?? "");
    setIsSynthetic(Boolean(i.is_synthetic));
  }, []);

  // On mount: detect server, load any preloaded region, else go "empty".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          await api.health();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (cancelled) return;
      try {
        const i = await api.info();
        if (cancelled) return;
        if (i.ready && i.bounds) {
          applyInfo(i);
          setActiveRegion({ ...i.bounds, zoom: 11, source: demTypeToSource(i.dem_type) });
          setStatus("ready");
          setStatusText("Ready");
        } else {
          setStatus("empty");
          setStatusText("No region");
        }
      } catch {
        setStatus("error");
        setStatusText("Unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, [applyInfo]);

  const activate = useCallback(async (bbox: Bounds, source: string) => {
    setStatus("computing");
    setStatusText("Computing…");
    try {
      const resp = await api.activateRegion({ ...bbox, source });
      setActiveRegion({ ...resp.bounds, zoom: resp.zoom, source });
      const i = await api.info();
      applyInfo(i);
      setOverlayVersion((v) => v + 1);
      setStatus("ready");
      setStatusText("Ready");
      toast("TTCI computed for the selected area.", "success");
    } catch (err) {
      setStatus(activeRegion ? "ready" : "empty");
      setStatusText(activeRegion ? "Ready" : "No region");
      toast((err as Error).message || "Could not assess that area — try a smaller box.", "error");
      throw err;
    }
  }, [applyInfo, toast, activeRegion]);

  const value: TtciState = {
    status, statusText, info, riskLevels, sourceLabel, isSynthetic,
    activeRegion, overlayVersion, lastQuery, toasts,
    activate, setLastQuery, toast, dismissToast,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTtci() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTtci must be used within TtciProvider");
  return ctx;
}

/** Resolve a TTCI value to its risk band color from the backend levels. */
export function riskColor(levels: RiskLevel[], ttci: number): string {
  for (let i = 0; i < levels.length; i++) {
    const lv = levels[i];
    const last = i === levels.length - 1;
    if (ttci >= lv.min && (last ? ttci <= lv.max : ttci < lv.max)) return lv.color;
  }
  return levels.length ? levels[levels.length - 1].color : "#888";
}
