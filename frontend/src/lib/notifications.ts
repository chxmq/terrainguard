/** Shared notification copy and API error normalization. */

export const NOTIFY = {
  regionSuccess: "Terrain assessed for the selected area.",
  regionRecomputed: "Region updated with the selected DEM.",
  regionFailed: "Could not assess that area. Try a smaller region or a different DEM source.",
  pointQueryFailed: "Could not read TTCI at that location.",
  msaFailed: "Route analysis failed. Check your waypoints and try again.",
  tawsFailed: "Terrain look-ahead failed. Place the aircraft inside the active region.",
} as const;

export function regionTooLargeMessage(latSpan: number, lonSpan: number, maxSpan = 12): string {
  return (
    `Selected area is ${latSpan.toFixed(1)}° × ${lonSpan.toFixed(1)}° (max ${maxSpan}° per side). ` +
    "Zoom in and draw a smaller box."
  );
}

/** Turn fetch/API errors into short, user-facing messages. */
export function formatApiError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  if (!raw || raw === "Failed to fetch" || raw.includes("NetworkError")) {
    return "Could not reach the server. Check that the backend is running.";
  }
  if (raw.startsWith("Request failed (HTTP")) return fallback;
  if (/not ready|no active region|503/i.test(raw)) {
    return "Select and assess a region on the map first.";
  }
  if (/could not acquire real terrain|region computation failed/i.test(raw)) {
    return NOTIFY.regionFailed;
  }
  if (/too large/i.test(raw)) return raw;
  if (raw.length > 140) return `${raw.slice(0, 137)}…`;
  return raw;
}
