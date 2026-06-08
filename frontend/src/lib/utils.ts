import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names (shadcn convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number to fixed decimals; em dash for missing values. */
export function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Number(value).toFixed(digits);
}

/** MSA route-simulation clearance bands (feet above terrain while flying at MSA). */
export const MSA_CLEARANCE_WARNING_FT = 1000;
export const MSA_CLEARANCE_CAUTION_FT = 2000;

export function msaClearanceStatus(ft: number): "WARNING" | "CAUTION" | "CLEAR" {
  if (ft < MSA_CLEARANCE_WARNING_FT) return "WARNING";
  if (ft < MSA_CLEARANCE_CAUTION_FT) return "CAUTION";
  return "CLEAR";
}

export function msaClearanceColor(ft: number): string {
  const status = msaClearanceStatus(ft);
  if (status === "WARNING") return "#e74c3c";
  if (status === "CAUTION") return "#e67e22";
  return "#2ecc71";
}

/** Format an integer with thousands separators. */
export function fmtInt(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return Math.round(Number(value)).toLocaleString("en-US");
}

/** Forward geodesic: destination from (lat,lon) along bearing for distanceKm. */
export function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceKm: number): [number, number] {
  const R = 6371.0;
  const d = distanceKm / R;
  const brg = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}
