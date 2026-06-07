import { useTtci } from "@/state/ttci";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function InfoPanel() {
  const { info, riskLevels, lastQuery, activeRegion } = useTtci();
  const stats = info?.stats;

  return (
    <div className="space-y-6">

      {/* ── Point Query ── */}
      <section>
        <SectionHead>Point Query</SectionHead>
        {!lastQuery ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {activeRegion
              ? "Click anywhere on the map to read the terrain risk at that point."
              : "Select a region first, then click the map to query."}
          </p>
        ) : (
          <div className="space-y-4">
            {/* TTCI hero */}
            <div>
              <div className="mb-1 text-[9px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
                TTCI Score
              </div>
              <div className="flex items-end gap-3">
                <span
                  className="font-mono text-5xl font-black leading-none"
                  style={{ color: lastQuery.risk_color }}
                >
                  {fmt(lastQuery.ttci, 3)}
                </span>
                <span
                  className="mb-1 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{
                    color: lastQuery.risk_color,
                    background: `${lastQuery.risk_color}22`,
                  }}
                >
                  {lastQuery.risk_level}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(lastQuery.ttci * 100, 100)}%`,
                    background: lastQuery.risk_color,
                  }}
                />
              </div>
            </div>

            {/* Terrain metrics */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
              <DataField
                label="Elevation"
                value={`${fmt(lastQuery.elevation_m, 0)} m`}
                sub={`${fmtInt(lastQuery.elevation_ft)} ft`}
              />
              <DataField label="Slope" value={`${fmt(lastQuery.metrics.slope_deg, 1)}°`} />
              <DataField label="TRI" value={`${fmt(lastQuery.metrics.tri_m, 1)} m`} />
              <DataField label="Elev σ" value={`${fmt(lastQuery.metrics.elevation_std_m, 1)} m`} />
            </div>
          </div>
        )}
      </section>

      {/* ── Region Statistics ── */}
      {stats && (
        <section className="border-t border-border pt-5">
          <SectionHead>Region Statistics</SectionHead>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <DataField label="Mean TTCI" value={fmt(stats.mean, 3)} accent />
            <DataField label="Max TTCI"  value={fmt(stats.max, 3)} accent />
            <DataField label="Min TTCI"  value={fmt(stats.min, 3)} />
            <DataField label="Std Dev"   value={fmt(stats.std, 3)} />
          </div>
        </section>
      )}

      {/* ── Risk Bands ── */}
      {riskLevels.length > 0 && (
        <section className="border-t border-border pt-5">
          <SectionHead>Risk Bands</SectionHead>
          <div className="space-y-2">
            {riskLevels.map((l) => (
              <div key={l.label} className="flex items-center gap-3">
                <span className="h-2 w-5 shrink-0 rounded-sm" style={{ background: l.color }} />
                <span className="text-xs font-medium text-foreground">{l.label}</span>
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

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        {children}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function DataField({
  label, value, sub, accent,
}: {
  label: string; value: string | React.ReactNode; sub?: string; accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 font-mono text-sm font-bold leading-tight", accent ? "text-primary" : "text-foreground")}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 font-mono text-[11px] leading-none text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}
