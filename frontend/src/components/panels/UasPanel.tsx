import { useState } from "react";
import { Navigation2 } from "lucide-react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools, type CorridorSegment } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/utils";
import { formatApiError } from "@/lib/notifications";

const NM_PER_METER = 1 / 1852;

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

export function UasPanel() {
  const { activeRegion, toast } = useTtci();
  const {
    mode, setMode,
    corridorWaypoints, setCorridorWaypoints,
    corridorSegments, setCorridorSegments,
  } = useTools();
  const [corridorWidthM, setCorridorWidthM] = useState(100);
  const [busy, setBusy] = useState(false);

  const drawing = mode === "draw-corridor";
  const canCalc = corridorWaypoints.length >= 2 && !busy;

  const clear = () => {
    setCorridorWaypoints([]);
    setCorridorSegments(null);
    if (drawing) setMode("idle");
  };

  const calculate = async () => {
    if (corridorWaypoints.length < 2) return;
    setBusy(true);
    try {
      const halfWidthNm = (corridorWidthM / 2) * NM_PER_METER;
      const pairs = corridorWaypoints.slice(0, -1).map((from, i) => ({
        from,
        to: corridorWaypoints[i + 1],
        segIdx: i,
      }));
      const results = await Promise.all(
        pairs.map(({ from, to }) => api.uasCorridor([from, to], halfWidthNm)),
      );
      const segments: CorridorSegment[] = pairs.map(({ from, to, segIdx }, i) => ({
        segIdx,
        from,
        to,
        distKm: haversineKm(from, to),
        result: results[i],
      }));
      setCorridorSegments(segments);
    } catch (err) {
      toast(
        formatApiError(err, "Corridor assessment failed. Is a terrain region loaded?"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const totalKm = corridorSegments
    ? corridorSegments.reduce((s, seg) => s + seg.distKm, 0)
    : null;

  const peakSeg = corridorSegments?.reduce<CorridorSegment | null>(
    (worst, seg) =>
      seg.result.ttci.mean > (worst?.result.ttci.mean ?? -Infinity) ? seg : worst,
    null,
  ) ?? null;

  return (
    <div className="space-y-5">
      {!activeRegion && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Select a terrain area on the map first.
        </p>
      )}

      <section>
        <SectionHead>1. Draw corridor</SectionHead>
        <p className="mb-3 text-sm text-muted-foreground">
          Click waypoints on the map, double-click to finish. Each consecutive pair becomes one assessed segment.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={drawing ? "secondary" : "default"}
            disabled={!activeRegion}
            onClick={() => setMode(drawing ? "idle" : "draw-corridor")}
          >
            <Navigation2 className="h-3.5 w-3.5" />
            {drawing ? "Drawing…" : "Draw corridor"}
          </Button>
          <Button size="sm" variant="outline" onClick={clear}>
            Clear
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {corridorWaypoints.length === 0
            ? "No waypoints yet"
            : `${corridorWaypoints.length} waypoint${corridorWaypoints.length === 1 ? "" : "s"} · ${corridorWaypoints.length - 1} segment${corridorWaypoints.length - 1 === 1 ? "" : "s"}`}
        </p>
      </section>

      <section>
        <SectionHead>2. Corridor width</SectionHead>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={50}
            max={500}
            step={10}
            value={corridorWidthM}
            onChange={(e) => setCorridorWidthM(Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="w-16 shrink-0 text-right font-mono text-sm text-foreground">
            {corridorWidthM} m
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Total corridor width (±{corridorWidthM / 2} m each side)
        </p>
      </section>

      <section>
        <SectionHead>3. Assess risk</SectionHead>
        <Button size="sm" className="w-full" disabled={!canCalc} onClick={calculate}>
          {busy ? "Assessing…" : "Assess corridor risk"}
        </Button>
      </section>

      {corridorSegments && corridorSegments.length > 0 && (
        <>
          <section>
            <SectionHead>Corridor summary</SectionHead>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Peak risk
                </div>
                <div className="font-bold" style={{ color: peakSeg?.result.peak_risk_color }}>
                  {peakSeg?.result.peak_risk_level ?? "—"}
                </div>
              </div>
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Total length
                </div>
                <div className="font-mono font-semibold text-foreground">
                  {totalKm?.toFixed(1) ?? "—"} km
                </div>
              </div>
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Max TTCI
                </div>
                <div
                  className="font-mono font-semibold"
                  style={{ color: peakSeg?.result.dominant_risk_color }}
                >
                  {fmt(peakSeg?.result.ttci.mean ?? null, 3)}
                </div>
              </div>
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Segments
                </div>
                <div className="font-mono font-semibold text-foreground">
                  {corridorSegments.length}
                </div>
              </div>
            </div>
          </section>

          <section>
            <SectionHead>Risk by segment</SectionHead>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  <th className="pb-2 text-left font-medium">Seg</th>
                  <th className="pb-2 text-left font-medium">Length</th>
                  <th className="pb-2 text-left font-medium">TTCI</th>
                  <th className="pb-2 text-left font-medium">Risk</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {corridorSegments.map((seg) => (
                  <tr key={seg.segIdx} className="border-b border-border/50">
                    <td className="py-2">
                      <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-bold text-purple-300">
                        S{seg.segIdx + 1}
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">{seg.distKm.toFixed(1)} km</td>
                    <td
                      className="py-2 font-semibold"
                      style={{ color: seg.result.dominant_risk_color }}
                    >
                      {fmt(seg.result.ttci.mean, 3)}
                    </td>
                    <td className="py-2" style={{ color: seg.result.dominant_risk_color }}>
                      {seg.result.dominant_risk_level}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <p className="border-t border-border/40 pt-2 text-[10px] leading-snug text-muted-foreground/70">
            Corridor width {corridorWidthM} m · half-width {(corridorWidthM / 2).toFixed(0)} m per side.
            Higher TTCI indicates terrain complexity requiring greater obstacle separation or alternate routing.
          </p>
        </>
      )}
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="text-section shrink-0">{children}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
