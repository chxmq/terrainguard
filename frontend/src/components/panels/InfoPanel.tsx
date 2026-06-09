import { useTtci } from "@/state/ttci";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

const STEPS = [
  "Use Select area (top-left of map) to draw a region to assess.",
  "Click anywhere on the map to see terrain complexity and elevation.",
  "Open Route, Alerts, or UAS in this sidebar for flight-planning tools.",
];

export function InfoPanel() {
  const { info, lastQuery, activeRegion } = useTtci();
  const stats = info?.stats;
  const dist = info?.risk_distribution ?? [];
  const highCritical = dist
    .filter((b) => b.min >= 0.6)
    .reduce((sum, b) => sum + b.pct, 0);

  return (
    <div className="space-y-5">
      {!activeRegion && (
        <section className="rounded-lg border border-border bg-secondary/50 p-4">
          <h3 className="text-section mb-2">Quick start</h3>
          <ol className="list-decimal space-y-1.5 pl-4 text-body-sm">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <SectionHead>Map click result</SectionHead>
        {!lastQuery ? (
          <p className="text-body-sm">
            {activeRegion
              ? "Click the map to see the risk score and elevation at that location."
              : "Select a region on the map first."}
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-label mb-1.5">Terrain complexity</div>
              <div className="flex items-end gap-3">
                <span
                  className="text-metric-lg"
                  style={{ color: lastQuery.risk_color }}
                >
                  {fmt(lastQuery.ttci, 2)}
                </span>
                <span
                  className="mb-1 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                  style={{ color: lastQuery.risk_color, background: `${lastQuery.risk_color}18` }}
                >
                  {lastQuery.risk_level}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
              <DataField label="Elevation" value={`${fmtInt(lastQuery.elevation_ft)} ft`} />
              <DataField label="Slope" value={`${fmt(lastQuery.metrics.slope_deg, 1)}°`} />
              <DataField label="Ruggedness" value={`${fmt(lastQuery.metrics.tri_m, 0)} m`} />
              <DataField label="Variation" value={`${fmt(lastQuery.metrics.elevation_std_m, 0)} m`} />
            </div>
          </div>
        )}
      </section>

      {stats && (
        <section className="border-t border-border pt-4">
          <SectionHead>Region summary</SectionHead>
          <div className="grid grid-cols-2 gap-3">
            <DataField label="Average risk" value={fmt(stats.mean, 2)} accent />
            <DataField label="High / Critical area" value={`${highCritical.toFixed(0)}%`} accent />
          </div>

          {dist.length > 0 && (
            <div className="mt-4">
              <div className="text-label mb-1.5">Area by risk band</div>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-secondary">
                {dist.map((b) =>
                  b.pct > 0 ? (
                    <div
                      key={b.label}
                      style={{ width: `${b.pct}%`, background: b.color }}
                      title={`${b.label}: ${b.pct}%`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="mt-2.5 space-y-1.5">
                {dist.map((b) => (
                  <li key={b.label} className="flex items-center gap-2 text-body-sm">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: b.color }} />
                    <span className="text-foreground">{b.label}</span>
                    <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                      {b.pct}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[10px] leading-snug text-muted-foreground/70">
            TTCI is normalized per region (2nd–98th percentile), so values are relative to this
            area's terrain. Average and band shares describe overall complexity better than the
            raw min/max.
          </p>
        </section>
      )}
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <h3 className="text-section shrink-0">{children}</h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function DataField({
  label, value, accent,
}: {
  label: string; value: string | React.ReactNode; accent?: boolean;
}) {
  return (
    <div>
      <div className="text-label mb-0.5">{label}</div>
      <div className={cn(accent ? "text-metric-accent" : "text-metric")}>{value}</div>
    </div>
  );
}
