import { useState } from "react";
import { Navigation2, Route } from "lucide-react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools, type CorridorSegment } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/utils";
import { formatApiError } from "@/lib/notifications";

const NM_PER_METER = 1 / 1852;

type UasMode = "assess" | "plan";

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
    uasPlanStart, setUasPlanStart,
    uasPlanEnd, setUasPlanEnd,
    uasPickTarget, setUasPickTarget,
    uasPlannedPath, setUasPlannedPath,
    uasPlanResult, setUasPlanResult,
    logAssessment,
  } = useTools();

  const [uasMode, setUasMode] = useState<UasMode>("assess");
  const [corridorWidthM, setCorridorWidthM] = useState(100);
  const [maxAltitudeM, setMaxAltitudeM] = useState(8000);
  const [maxTtci, setMaxTtci] = useState(0.6);
  const [busy, setBusy] = useState(false);

  const drawing = mode === "draw-corridor";
  const picking = mode === "plan-uas-route";
  const canAssess = corridorWaypoints.length >= 2 && !busy;
  const canPlan = Boolean(uasPlanStart && uasPlanEnd && !busy);

  const switchMode = (next: UasMode) => {
    setUasMode(next);
    setMode("idle");
    if (next === "assess") {
      setUasPlanStart(null);
      setUasPlanEnd(null);
      setUasPlannedPath(null);
      setUasPlanResult(null);
    } else {
      setCorridorWaypoints([]);
      setCorridorSegments(null);
    }
  };

  const clearAssess = () => {
    setCorridorWaypoints([]);
    setCorridorSegments(null);
    if (drawing) setMode("idle");
  };

  const clearPlan = () => {
    setUasPlanStart(null);
    setUasPlanEnd(null);
    setUasPlannedPath(null);
    setUasPlanResult(null);
    if (picking) setMode("idle");
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
      const totalDist = segments.reduce((s, seg) => s + seg.distKm, 0);
      const worst = segments.reduce<CorridorSegment | null>(
        (w, seg) => (seg.result.ttci.mean > (w?.result.ttci.mean ?? -Infinity) ? seg : w),
        null,
      );
      logAssessment({
        kind: "uas-corridor",
        title: `UAS corridor · ${segments.length} segment${segments.length === 1 ? "" : "s"}`,
        riskColor: worst?.result.dominant_risk_color,
        lat: corridorWaypoints[0]?.[0] ?? null,
        lon: corridorWaypoints[0]?.[1] ?? null,
        lines: [
          `Peak risk ${worst?.result.peak_risk_level ?? "—"} · max TTCI ${fmt(worst?.result.ttci.mean ?? null, 3)}`,
          `Length ${totalDist.toFixed(1)} km · width ${corridorWidthM} m`,
        ],
      });
    } catch (err) {
      toast(
        formatApiError(err, "Corridor assessment failed. Is a terrain region loaded?"),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const planRoute = async () => {
    if (!uasPlanStart || !uasPlanEnd) return;
    setBusy(true);
    setUasPlanResult(null);
    setUasPlannedPath(null);
    try {
      const result = await api.uasPlanRoute({
        start: uasPlanStart,
        end: uasPlanEnd,
        max_altitude_m: maxAltitudeM,
        max_ttci: maxTtci,
      });
      setUasPlanResult(result);
      if (result.ok && result.path) {
        setUasPlannedPath(result.path.map((p) => [p[0], p[1]] as [number, number]));
        toast(`Safe corridor found · ${result.stats?.node_count ?? 0} waypoints`, "success");
        logAssessment({
          kind: "uas-route",
          title: "UAS route plan · safe path found",
          riskColor: result.stats?.peak_risk_color,
          lat: uasPlanStart[0],
          lon: uasPlanStart[1],
          lines: [
            `Peak risk ${result.stats?.peak_risk_level ?? "—"} · max TTCI ${fmt(result.stats?.max_ttci ?? null, 3)}`,
            `${result.stats?.node_count ?? 0} waypoints · ceiling ${maxAltitudeM} m · limit ${maxTtci.toFixed(2)}`,
          ],
        });
      } else if (!result.ok) {
        toast(result.error ?? "No safe corridor found", "error");
        logAssessment({
          kind: "uas-route",
          title: "UAS route plan · no safe path",
          lat: uasPlanStart[0],
          lon: uasPlanStart[1],
          lines: [
            result.error ?? "No safe corridor found",
            `ceiling ${maxAltitudeM} m · limit ${maxTtci.toFixed(2)}`,
          ],
        });
      }
    } catch (err) {
      toast(formatApiError(err, "Route planning failed. Is a terrain region loaded?"), "error");
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

  const plannedKm = uasPlannedPath && uasPlannedPath.length > 1
    ? uasPlannedPath.slice(0, -1).reduce((sum, pt, i) => sum + haversineKm(pt, uasPlannedPath[i + 1]), 0)
    : null;

  return (
    <div className="space-y-5">
      {!activeRegion && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Select a terrain area on the map first.
        </p>
      )}

      <section>
        <SectionHead>Mode</SectionHead>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={uasMode === "assess" ? "default" : "outline"}
            className="flex-1"
            onClick={() => switchMode("assess")}
          >
            <Navigation2 className="h-3.5 w-3.5" />
            Assess corridor
          </Button>
          <Button
            size="sm"
            variant={uasMode === "plan" ? "default" : "outline"}
            className="flex-1"
            onClick={() => switchMode("plan")}
          >
            <Route className="h-3.5 w-3.5" />
            Plan route
          </Button>
        </div>
      </section>

      {uasMode === "assess" ? (
        <>
          <section>
            <SectionHead>1. Draw corridor</SectionHead>
            <p className="mb-3 text-sm text-muted-foreground">
              Click waypoints on the map, double-click to finish.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={drawing ? "secondary" : "default"}
                disabled={!activeRegion}
                onClick={() => setMode(drawing ? "idle" : "draw-corridor")}
              >
                {drawing ? "Drawing…" : "Draw corridor"}
              </Button>
              <Button size="sm" variant="outline" onClick={clearAssess}>
                Clear
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {corridorWaypoints.length === 0
                ? "No waypoints yet"
                : `${corridorWaypoints.length} waypoint${corridorWaypoints.length === 1 ? "" : "s"}`}
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
          </section>

          <section>
            <SectionHead>3. Assess risk</SectionHead>
            <Button size="sm" className="w-full" disabled={!canAssess} onClick={calculate}>
              {busy ? "Assessing…" : "Assess corridor risk"}
            </Button>
          </section>

          {corridorSegments && corridorSegments.length > 0 && (
            <AssessResults
              corridorSegments={corridorSegments}
              peakSeg={peakSeg}
              totalKm={totalKm}
              corridorWidthM={corridorWidthM}
            />
          )}
        </>
      ) : (
        <>
          <section>
            <SectionHead>1. Pick start & end</SectionHead>
            <p className="mb-3 text-sm text-muted-foreground">
              Choose which point to place, then click the map.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={picking && uasPickTarget === "start" ? "secondary" : "outline"}
                disabled={!activeRegion}
                onClick={() => {
                  setUasPickTarget("start");
                  setMode("plan-uas-route");
                }}
              >
                {uasPlanStart ? "Move start" : "Set start"}
              </Button>
              <Button
                size="sm"
                variant={picking && uasPickTarget === "end" ? "secondary" : "outline"}
                disabled={!activeRegion}
                onClick={() => {
                  setUasPickTarget("end");
                  setMode("plan-uas-route");
                }}
              >
                {uasPlanEnd ? "Move end" : "Set end"}
              </Button>
              <Button size="sm" variant="outline" onClick={clearPlan}>
                Clear
              </Button>
            </div>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <div>
                Start:{" "}
                {uasPlanStart
                  ? `${uasPlanStart[0].toFixed(4)}, ${uasPlanStart[1].toFixed(4)}`
                  : "not set"}
              </div>
              <div>
                End:{" "}
                {uasPlanEnd
                  ? `${uasPlanEnd[0].toFixed(4)}, ${uasPlanEnd[1].toFixed(4)}`
                  : "not set"}
              </div>
            </div>
          </section>

          <section>
            <SectionHead>2. Flight limits</SectionHead>
            <label className="mb-1 block text-[11px] text-muted-foreground">
              Max altitude ({maxAltitudeM} m)
            </label>
            <input
              type="range"
              min={500}
              max={12000}
              step={100}
              value={maxAltitudeM}
              onChange={(e) => setMaxAltitudeM(Number(e.target.value))}
              className="mb-3 w-full accent-primary"
            />
            <label className="mb-1 block text-[11px] text-muted-foreground">
              Max acceptable TTCI ({maxTtci.toFixed(2)})
            </label>
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={maxTtci}
              onChange={(e) => setMaxTtci(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </section>

          <section>
            <SectionHead>3. Find safe path</SectionHead>
            <Button size="sm" className="w-full" disabled={!canPlan} onClick={planRoute}>
              {busy ? "Planning…" : "Find safe corridor"}
            </Button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              A* routing avoids cells above your TTCI limit and terrain above your ceiling.
            </p>
          </section>

          {uasPlanResult && !uasPlanResult.ok && (
            <section className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm">
              <div className="font-semibold text-red-200">{uasPlanResult.error}</div>
              <p className="mt-1 text-xs text-red-200/80">{uasPlanResult.detail}</p>
            </section>
          )}

          {uasPlanResult?.ok && uasPlanResult.stats && (
            <section>
              <SectionHead>Planned corridor</SectionHead>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Peak risk" value={uasPlanResult.stats.peak_risk_level} color={uasPlanResult.stats.peak_risk_color} />
                <Stat label="Path length" value={`${plannedKm?.toFixed(1) ?? "—"} km`} />
                <Stat label="Max TTCI" value={fmt(uasPlanResult.stats.max_ttci, 3)} color={uasPlanResult.stats.peak_risk_color} />
                <Stat label="Waypoints" value={String(uasPlanResult.stats.node_count)} />
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                Hover clearance {uasPlanResult.stats.flight_clearance_m} m · computed in {uasPlanResult.stats.calc_time_ms} ms
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AssessResults({
  corridorSegments,
  peakSeg,
  totalKm,
  corridorWidthM,
}: {
  corridorSegments: CorridorSegment[];
  peakSeg: CorridorSegment | null;
  totalKm: number | null;
  corridorWidthM: number;
}) {
  return (
    <>
      <section>
        <SectionHead>Corridor summary</SectionHead>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="Peak risk" value={peakSeg?.result.peak_risk_level ?? "—"} color={peakSeg?.result.peak_risk_color} />
          <Stat label="Total length" value={`${totalKm?.toFixed(1) ?? "—"} km`} />
          <Stat label="Max TTCI" value={fmt(peakSeg?.result.ttci.mean ?? null, 3)} color={peakSeg?.result.dominant_risk_color} />
          <Stat label="Segments" value={String(corridorSegments.length)} />
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
                <td className="py-2 font-semibold" style={{ color: seg.result.dominant_risk_color }}>
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
      </p>
    </>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md bg-secondary/60 px-3 py-2">
      <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-semibold" style={color ? { color } : undefined}>{value}</div>
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
