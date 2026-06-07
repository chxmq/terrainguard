import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function CfitPanel() {
  const { toast } = useTtci();
  const { validation, setValidation, cfitShown, setCfitShown, setView } = useTools();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (validation) return;
    setLoading(true);
    api.validation()
      .then(setValidation)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">Loading validation data…</p>;
  if (error || !validation)
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Validation report unavailable{error ? `: ${error}` : ""}.
        Generate it with{" "}
        <code className="rounded bg-secondary px-1 font-mono text-[11px]">
          python validate_ttci.py
        </code>{" "}
        in the backend directory, then reopen this tab.
      </p>
    );

  const s = validation.summary;
  return (
    <div className="space-y-5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        TTCI validated against {s.n_accidents} real CFIT impact sites. Scores at
        crash coordinates vs surrounding control terrain.
      </p>

      {/* ── Model Score ── */}
      <section>
        <SectionHead>Model Performance</SectionHead>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              ROC AUC (≤1 km)
            </div>
            <div className="mt-0.5 font-mono text-3xl font-black leading-none text-risk-vlow">
              {fmt(s.auc_neighbourhood_1km, 2)}
            </div>
          </div>
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Sites High / Critical
            </div>
            <div className="mt-0.5 font-mono text-3xl font-black leading-none text-primary">
              {fmt(s.accident_pct_high_or_critical, 0)}%
            </div>
          </div>
        </div>
      </section>

      {/* ── TTCI Distribution ── */}
      <section>
        <SectionHead>TTCI Distribution</SectionHead>
        <div className="space-y-2.5">
          <Bar label="Crash sites"  value={s.accident_mean_ttci} cls="bg-gradient-to-r from-risk-high to-risk-critical" />
          <Bar label="Surrounding"  value={s.control_mean_ttci}  cls="bg-risk-vlow" />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Crash-site mean TTCI {fmt(s.accident_mean_ttci, 2)} vs. surrounding{" "}
          {fmt(s.control_mean_ttci, 2)} — a {fmt(s.lift_mean, 2)}× lift.
        </p>
      </section>

      {/* ── Map Toggle ── */}
      <Button
        size="sm"
        className="w-full"
        variant={cfitShown ? "secondary" : "default"}
        onClick={() => { setCfitShown(!cfitShown); if (!cfitShown) setView("2d"); }}
      >
        {cfitShown ? "Hide accident sites" : "Show accident sites on map"}
      </Button>

      {/* ── Accident Log ── */}
      <section>
        <SectionHead>Accident Log</SectionHead>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              <th className="pb-2 text-left font-medium">Flight</th>
              <th className="pb-2 text-left font-medium">TTCI</th>
              <th className="pb-2 text-left font-medium">Risk</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {validation.accidents.map((a) => (
              <tr key={a.flight} className="border-b border-border/50">
                <td className="py-2">
                  <div className="font-semibold text-foreground">{a.flight}</div>
                  <div className="text-[10px] text-muted-foreground">{a.country}</div>
                </td>
                <td className="py-2">
                  <div>{fmt(a.site_ttci, 2)}</div>
                  <div className="text-[10px] text-muted-foreground">{fmt(a.site_max_1km, 2)} @1 km</div>
                </td>
                <td className="py-2 font-bold" style={{ color: a.risk_color }}>
                  {a.risk_level}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Exact-cell AUC {fmt(s.auc_exact_cell, 2)} (p={s.mannwhitney_p_exact.toExponential(1)});
        neighbourhood AUC {fmt(s.auc_neighbourhood_1km, 2)} (p={s.mannwhitney_p_1km.toExponential(1)}).
        Crash sites average the {fmt(s.accident_mean_site_percentile, 0)}th percentile of local
        terrain complexity. {fmtInt(s.n_controls)} control samples.
      </p>
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

function Bar({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn("h-full rounded-full", cls)}
          style={{ width: `${Math.min(value * 100, 100)}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-[11px] font-semibold">
        {fmt(value, 2)}
      </span>
    </div>
  );
}
