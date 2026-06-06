import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTtci } from "@/state/ttci";
import { fmt, fmtInt } from "@/lib/utils";

export function InfoPanel() {
  const { info, riskLevels, lastQuery, activeRegion } = useTtci();
  const stats = info?.stats;

  return (
    <div className="space-y-5">
      {/* Point query result */}
      <section>
        <h3 className="mb-2 text-[13px] font-bold">Point Query</h3>
        {!lastQuery ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {activeRegion
              ? "Click anywhere on the map to read the terrain risk at that location."
              : "Select an area first, then click the map to query a point."}
          </p>
        ) : (
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="text-center">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">TTCI Score</div>
                <div className="font-mono text-4xl font-extrabold" style={{ color: lastQuery.risk_color }}>
                  {fmt(lastQuery.ttci, 3)}
                </div>
                <Badge
                  className="mt-1"
                  style={{ color: lastQuery.risk_color, background: `${lastQuery.risk_color}22`, borderColor: `${lastQuery.risk_color}55` }}
                >
                  {lastQuery.risk_level}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Metric label="Elevation" value={`${fmt(lastQuery.elevation_m, 0)} m`} sub={`${fmtInt(lastQuery.elevation_ft)} ft`} />
                <Metric label="Slope" value={`${fmt(lastQuery.metrics.slope_deg, 1)}°`} />
                <Metric label="TRI" value={`${fmt(lastQuery.metrics.tri_m, 1)} m`} />
                <Metric label="Elev σ" value={`${fmt(lastQuery.metrics.elevation_std_m, 1)} m`} />
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Region stats */}
      {stats && (
        <section>
          <h3 className="mb-2 text-[13px] font-bold">Region Statistics</h3>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Mean TTCI" value={fmt(stats.mean, 3)} />
            <Stat label="Max TTCI" value={fmt(stats.max, 3)} />
            <Stat label="Min TTCI" value={fmt(stats.min, 3)} />
            <Stat label="Std Dev" value={fmt(stats.std, 3)} />
          </div>
        </section>
      )}

      {/* Legend */}
      {riskLevels.length > 0 && (
        <section>
          <h3 className="mb-2 text-[13px] font-bold">Risk Legend</h3>
          <div className="space-y-1.5">
            {riskLevels.map((l) => (
              <div key={l.label} className="flex items-center gap-2.5 text-xs">
                <span className="h-3.5 w-6 rounded" style={{ background: l.color }} />
                <span className="font-medium text-foreground/90">{l.label}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {fmt(l.min, 1)}–{fmt(l.max, 1)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold">
        {value} {sub && <span className="text-[11px] font-normal text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-base font-bold text-primary">{value}</div>
    </div>
  );
}
