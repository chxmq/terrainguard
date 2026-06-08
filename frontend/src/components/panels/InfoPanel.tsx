import { useTtci } from "@/state/ttci";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

const STEPS = [
  "Use Select area (top-left of map) or pick a preset region.",
  "Click anywhere on the map to see terrain complexity and elevation.",
  "Open Route or Alerts in this sidebar for flight-planning tools.",
];

export function InfoPanel() {
  const { info, riskLevels, lastQuery, activeRegion } = useTtci();
  const stats = info?.stats;

  return (
    <div className="space-y-5">
      {!activeRegion && (
        <section className="rounded-lg border border-border bg-secondary/50 p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Quick start</h3>
          <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <SectionHead>Map click result</SectionHead>
        {!lastQuery ? (
          <p className="text-sm text-muted-foreground">
            {activeRegion
              ? "Click the map to see the risk score and elevation at that location."
              : "Select a region on the map first."}
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Terrain complexity</div>
              <div className="flex items-end gap-3">
                <span
                  className="font-mono text-4xl font-bold leading-none"
                  style={{ color: lastQuery.risk_color }}
                >
                  {fmt(lastQuery.ttci, 2)}
                </span>
                <span
                  className="mb-1 rounded-md px-2 py-0.5 text-xs font-semibold"
                  style={{ color: lastQuery.risk_color, background: `${lastQuery.risk_color}18` }}
                >
                  {lastQuery.risk_level}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
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
          <div className="grid grid-cols-2 gap-3 text-sm">
            <DataField label="Average risk" value={fmt(stats.mean, 2)} accent />
            <DataField label="Highest risk" value={fmt(stats.max, 2)} accent />
            <DataField label="Lowest risk" value={fmt(stats.min, 2)} />
          </div>
        </section>
      )}

      {riskLevels.length > 0 && (
        <section className="border-t border-border pt-4">
          <SectionHead>Risk scale</SectionHead>
          <div className="space-y-2">
            {riskLevels.map((l) => (
              <div key={l.label} className="flex items-center gap-2 text-sm">
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: l.color }} />
                <span className="text-foreground">{l.label}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-foreground">{children}</h3>;
}

function DataField({
  label, value, accent,
}: {
  label: string; value: string | React.ReactNode; accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("font-medium", accent ? "text-primary" : "text-foreground")}>{value}</div>
    </div>
  );
}
