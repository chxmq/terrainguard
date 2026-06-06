import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmt, fmtInt } from "@/lib/utils";

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

  if (loading) return <p className="text-xs text-muted-foreground">Loading validation…</p>;
  if (error || !validation)
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Validation report not available{error ? `: ${error}` : ""}. Generate it with{" "}
        <code className="rounded bg-secondary px-1">python validate_ttci.py</code> in the backend, then reopen this tab.
      </p>
    );

  const s = validation.summary;
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Does TTCI predict where terrain accidents happen? Scored at {s.n_accidents} real CFIT impact sites vs surrounding terrain.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Card className="border-risk-vlow/40 bg-risk-vlow/5">
          <CardContent className="p-3 text-center">
            <div className="font-mono text-2xl font-extrabold text-risk-vlow">{fmt(s.auc_neighbourhood_1km, 2)}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">ROC AUC (≤1 km)</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <div className="font-mono text-2xl font-extrabold text-primary">{fmt(s.accident_pct_high_or_critical, 0)}%</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Sites High/Critical</div>
          </CardContent>
        </Card>
      </div>

      <div>
        <Bar label="Crash sites" value={s.accident_mean_ttci} cls="bg-gradient-to-r from-risk-high to-risk-critical" />
        <Bar label="Surrounding" value={s.control_mean_ttci} cls="bg-risk-vlow" />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Mean TTCI at crash sites ({fmt(s.accident_mean_ttci, 2)}) vs surrounding terrain ({fmt(s.control_mean_ttci, 2)}) — a {fmt(s.lift_mean, 2)}× lift.
        </p>
      </div>

      <Button
        size="sm"
        className="w-full"
        variant={cfitShown ? "secondary" : "default"}
        onClick={() => { setCfitShown(!cfitShown); if (!cfitShown) setView("2d"); }}
      >
        {cfitShown ? "Hide accident sites" : "Show accident sites on map"}
      </Button>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-secondary/50 text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5 text-left">Flight</th>
              <th className="px-2 py-1.5 text-left">TTCI</th>
              <th className="px-2 py-1.5 text-left">Risk</th>
            </tr>
          </thead>
          <tbody>
            {validation.accidents.map((a) => (
              <tr key={a.flight} className="border-t border-border">
                <td className="px-2 py-1.5">{a.flight}<div className="text-[10px] text-muted-foreground">{a.country}</div></td>
                <td className="px-2 py-1.5 font-mono">{fmt(a.site_ttci, 2)}<div className="text-[10px] text-muted-foreground">{fmt(a.site_max_1km, 2)} @1km</div></td>
                <td className="px-2 py-1.5 font-semibold" style={{ color: a.risk_color }}>{a.risk_level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Exact-coordinate AUC {fmt(s.auc_exact_cell, 2)} (p={s.mannwhitney_p_exact.toExponential(1)}); impact-neighbourhood AUC {fmt(s.auc_neighbourhood_1km, 2)} (p={s.mannwhitney_p_1km.toExponential(1)}). Crash sites average the {fmt(s.accident_mean_site_percentile, 0)}th percentile of local terrain complexity. {fmtInt(s.n_controls)} control samples.
      </p>
    </div>
  );
}

function Bar({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.min(value * 100, 100)}%` }} />
      </div>
      <span className="w-10 text-right font-mono text-xs">{fmt(value, 2)}</span>
    </div>
  );
}
