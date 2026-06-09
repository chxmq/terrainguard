/** Typed client for the Terrain Guard FastAPI backend (proxied at /api). */

export interface RiskLevel { min: number; max: number; label: string; color: string }
export interface RiskBand { min: number; max: number; label: string; color: string; count: number; pct: number }
export interface Bounds { south: number; north: number; west: number; east: number }
export interface Stats { min: number; max: number; mean: number; std: number }

export interface Info {
  ready: boolean;
  is_synthetic?: boolean;
  dem_type?: string;
  source_label?: string;
  source?: string;
  zoom?: number;
  bounds?: Bounds;
  shape?: [number, number];
  stats?: Stats;
  risk_levels?: RiskLevel[];
  risk_distribution?: RiskBand[];
}

export interface ActivateResponse {
  ready: boolean;
  zoom: number;
  source?: string;
  is_synthetic: boolean;
  dem_type: string;
  source_label: string;
  bounds: Bounds;
  shape: [number, number];
  stats: Stats;
}

export interface PointQuery {
  lat: number; lon: number;
  elevation_m: number; elevation_ft: number;
  ttci: number; risk_level: string; risk_color: string;
  metrics: { slope_deg: number; tri_m: number; curvature: number; elevation_std_m: number };
}

export interface MsaSector {
  sector: number;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  distance_km: number; distance_nm: number;
  max_terrain_m: number; max_terrain_ft: number;
  msa_ft: number; msa_m: number; buffer_nm: number;
  ttci: { min: number; max: number; mean: number } | null;
}

export interface ProfilePoint { distance_km: number; elevation_m: number; lat: number; lon: number }

export interface TawsLookahead {
  alert_level: "CLEAR" | "CAUTION" | "WARNING";
  alert: boolean; alert_color: string; callout: string;
  trigger: null | {
    time_s: number; distance_nm: number; lat: number; lon: number;
    terrain_ft: number; path_alt_ft: number; clearance_ft: number; ttci: number | null;
  };
  min_clearance_ft: number | null;
  mean_path_ttci: number;
  envelope: {
    caution_lookahead_s: number; warning_lookahead_s: number;
    caution_clearance_ft: number; warning_clearance_ft: number;
    horizon_nm: number; ttci_time_gain_applied: number; ttci_clearance_gain_applied: number;
  };
  profile: Array<{
    time_s: number; distance_nm: number; lat: number; lon: number;
    terrain_ft: number; path_alt_ft: number; clearance_ft: number; ttci: number | null;
  }>;
}

export interface PatchMetrics {
  ttci_png: string;
  estd_png: string;
  corr: number;
  bounds: { south: number; north: number; west: number; east: number };
}

export interface CorridorResult {
  waypoints: number[][];
  buffer_nm: number;
  valid_cell_count: number;
  ttci: { min: number; max: number; mean: number };
  peak_risk_level: string;
  peak_risk_color: string;
  dominant_risk_level: string;
  dominant_risk_color: string;
}

export interface RegionGrid {
  rows: number;
  cols: number;
  bounds: Bounds;
  elev_min: number;
  elev_max: number;
  source_label?: string;
  ttci: number[][];
  elevation: number[][];
  elevation_m: number[][];
  slope_deg: number[][];
  tri_m: number[][];
}

export interface UasPlanRouteStats {
  node_count: number;
  max_ttci: number;
  mean_ttci: number;
  peak_risk_level: string;
  peak_risk_color: string;
  flight_clearance_m: number;
  calc_time_ms: number;
}

export interface UasPlanRouteResult {
  ok: boolean;
  path?: number[][];
  stats?: UasPlanRouteStats;
  error?: string;
  detail?: string;
}

export interface ValidationAccident {
  flight: string; date: string; site: string; country: string;
  lat: number; lon: number; fatalities: number; source: string;
  site_ttci: number; site_max_1km: number; site_percentile: number;
  risk_level: string; risk_color: string; elevation_m: number;
}
export interface Validation {
  summary: Record<string, number> & {
    n_accidents: number; n_controls: number;
    auc_exact_cell: number; auc_neighbourhood_1km: number;
    accident_mean_ttci: number; control_mean_ttci: number;
    accident_pct_high_or_critical: number; control_pct_high_or_critical: number;
    accident_mean_site_percentile: number; lift_mean: number;
    mannwhitney_p_exact: number; mannwhitney_p_1km: number;
    baseline_auc: Record<string, number>;
  };
  accidents: ValidationAccident[];
}

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}
async function jpost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await detail(res));
  return res.json();
}
async function detail(res: Response): Promise<string> {
  try {
    const d = await res.json();
    if (d?.detail) return typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail);
  } catch { /* ignore */ }
  return `Request failed (HTTP ${res.status}).`;
}

export const api = {
  health: () => jget<{ status: string; ready: boolean }>("/api/health"),
  info: () => jget<Info>("/api/info"),
  activateRegion: (b: Bounds & { zoom?: number; source?: string }) =>
    jpost<ActivateResponse>("/api/region/activate", b),
  overlayUrl: (version = 0) => `/api/ttci/overlay.png?v=${version}`,
  regionGridUrl: (b: Bounds & { zoom: number }, rows = 256, cols = 256) =>
    `/api/region/grid?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}&zoom=${b.zoom}&rows=${rows}&cols=${cols}`,
  regionGrid: (b: Bounds & { zoom: number; source?: string }, rows = 256, cols = 256) =>
    jget<RegionGrid>(
      `/api/region/grid?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}` +
      `&zoom=${b.zoom}&source=${b.source ?? "tiles"}&rows=${rows}&cols=${cols}`,
    ),
  regionOverlayUrl: (b: Bounds & { zoom: number }) =>
    `/api/region/overlay.png?south=${b.south}&north=${b.north}&west=${b.west}&east=${b.east}&zoom=${b.zoom}`,
  query: (lat: number, lon: number) => jget<PointQuery>(`/api/ttci/query?lat=${lat}&lon=${lon}`),
  msaCalculate: (waypoints: number[][]) =>
    jpost<{ sectors: MsaSector[]; waypoints: number[][] }>("/api/msa/calculate", { waypoints }),
  msaProfile: (waypoints: number[][]) =>
    jpost<{ profile: ProfilePoint[] }>("/api/msa/profile", { waypoints }),
  tawsLookahead: (b: {
    lat: number; lon: number; altitude_ft: number; heading_deg: number;
    ground_speed_kt: number; vertical_speed_fpm?: number;
  }) => jpost<TawsLookahead>("/api/taws/lookahead", b),
  validation: () => jget<Validation>("/api/validation"),
  validationGlobal: () => jget<Validation>("/api/validation/global"),
  patchMetrics: (lat: number, lon: number, dim = 64) =>
    jget<PatchMetrics>(`/api/validation/patch-metrics?lat=${lat}&lon=${lon}&dim=${dim}`),
  uasCorridor: (waypoints: number[][], buffer_nm: number) =>
    jpost<CorridorResult>("/api/uas/corridor", { waypoints, buffer_nm }),
  uasPlanRoute: (b: {
    start: number[];
    end: number[];
    max_altitude_m: number;
    max_ttci: number;
  }) => jpost<UasPlanRouteResult>("/api/uas/plan-route", b),
};
