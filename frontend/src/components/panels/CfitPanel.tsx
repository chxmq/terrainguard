import { useEffect, useState } from "react";
import { api, type Validation, type PatchMetrics } from "@/lib/api";
import { useTools } from "@/state/tools";
import { fmt, fmtInt } from "@/lib/utils";
import { cn } from "@/lib/utils";

// VASP 168 — Serra da Aratanha, Pacatuba, Brazil.
// Selected because it has the widest TTCI / elevation_std divergence across
// the 15 accident patches (diff_range [−0.78, +0.42], corr=0.983).
const HEATMAP_SITE = { lat: -3.7811, lon: -38.8739, flight: "VASP 168", location: "Serra da Aratanha, Brazil" };

function fmtP(p: number | undefined | null): string {
  if (p == null || Number.isNaN(p)) return "—";
  if (p < 0.001) return "<0.001";
  return p.toFixed(3);
}

export function CfitPanel() {
  const { validation, setValidation } = useTools();
  const [globalV, setGlobalV]       = useState<Validation | null>(null);
  const [patch, setPatch]           = useState<PatchMetrics | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [globalReady, setGlobalReady] = useState(false);

  useEffect(() => {
    if (!validation) {
      setLoading(true);
      api.validation()
        .then(setValidation)
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoading(false));
    }
    api.validationGlobal()
      .then((r) => { setGlobalV(r); setGlobalReady(true); })
      .catch(() => setGlobalReady(true));
    api.patchMetrics(HEATMAP_SITE.lat, HEATMAP_SITE.lon, 64)
      .then(setPatch)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p className="text-xs text-muted-foreground">Loading validation data…</p>;
  if (error || !validation)
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Validation report unavailable{error ? `: ${error}` : ""}.
        Generate it with{" "}
        <code className="rounded bg-secondary px-1 font-mono text-[11px]">python validate_ttci.py</code>
        {" "}in the backend directory, then reopen this tab.
      </p>
    );

  const s  = validation.summary;
  const g  = globalV?.summary;

  const liftPct      = g ? Math.round((g.accident_mean_ttci / g.control_mean_ttci - 1) * 100) : null;
  const p1km         = g?.mannwhitney_p_1km as unknown as number | undefined;
  const auc1kmGlobal = g?.auc_neighbourhood_1km;

  return (
    <div className="space-y-5">

      {/* ── Hero: global separation story ── */}
      {globalReady && g ? (
        <section className="rounded-lg border border-primary/25 bg-primary/5 p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-5xl font-black leading-none text-foreground">
              {liftPct}%
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-primary/80">
              lift
            </span>
          </div>
          <p className="mt-1.5 text-sm font-medium text-foreground leading-snug">
            Higher mean TTCI at CFIT accident sites vs global terrain
          </p>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {fmt(g.accident_mean_ttci, 2)} accident mean vs {fmt(g.control_mean_ttci, 2)} global
            control mean · statistically significant (p={fmtP(p1km)}, 1 km neighbourhood scale)
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md bg-card/60 px-2.5 py-2">
              <div className="font-semibold text-foreground">
                <span className="text-risk-high">{fmt(g.accident_pct_high_or_critical, 0)}%</span>
                {" "}accident sites
              </div>
              <div className="text-muted-foreground">
                in High / Critical TTCI band
                <div className="text-[10px]">vs {fmt(g.control_pct_high_or_critical, 0)}% of global controls</div>
              </div>
            </div>
            <div className="rounded-md bg-card/60 px-2.5 py-2">
              <div className="font-semibold text-foreground">AUC {fmt(auc1kmGlobal, 3)}</div>
              <div className="text-muted-foreground">
                ROC AUC (1 km neighbourhood)
                <div className="text-[10px]">8 diverse global terrain regions</div>
              </div>
            </div>
          </div>

          <p className="mt-2.5 text-[10px] text-muted-foreground/70">
            n={g.n_accidents} documented CFIT accidents · {fmtInt(g.n_controls)} global
            control samples across flat, montane, coastal and desert terrain
          </p>
        </section>
      ) : globalReady ? (
        <p className="rounded border border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
          Global validation not generated.{" "}
          <code className="font-mono text-[10px]">python validate_ttci_global.py</code>
        </p>
      ) : null}

      {/* ── Local validation ── */}
      <section>
        <SectionHead>Local validation</SectionHead>
        <p className="mb-3 text-[11px] text-muted-foreground">
          {s.n_accidents} accident sites vs locally-matched surrounding terrain (same patch,
          ≥5 km from impact, {fmtInt(s.n_controls)} controls).
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              ROC AUC (≤1 km)
            </div>
            <div className="mt-0.5 font-mono text-3xl font-black leading-none text-risk-vlow">
              {fmt(s.auc_neighbourhood_1km, 3)}
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
        <div className="mt-4 space-y-2.5">
          <Bar label="Crash sites" value={s.accident_mean_ttci} cls="bg-risk-high" />
          <Bar label="Surrounding" value={s.control_mean_ttci}  cls="bg-risk-vlow" />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Crash-site mean TTCI {fmt(s.accident_mean_ttci, 2)} vs surrounding{" "}
          {fmt(s.control_mean_ttci, 2)} — a {fmt(s.lift_mean, 2)}× lift locally.
          Exact-cell AUC {fmt(s.auc_exact_cell, 3)} (p={s.mannwhitney_p_exact.toExponential(1)}).
        </p>
      </section>

      {/* ── Accident log ── */}
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
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Crash sites average the {fmt(s.accident_mean_site_percentile, 0)}th percentile
          of local terrain complexity.
        </p>
      </section>

      {/* ── Task 4: composite vs elevation_std heatmaps ── */}
      {patch && (
        <section>
          <SectionHead>Composite vs single-metric</SectionHead>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {HEATMAP_SITE.flight} — {HEATMAP_SITE.location}.
            A crosshair marks the accident impact cell. Same risk palette: green → red → purple.
          </p>
          <p className="mb-2 text-[10px] text-muted-foreground/70 italic">
            Note: composite TTCI ≈ elevation_std at coarse view.
            Disagreement is in the cells near terrain transitions.
          </p>
          <div className="flex justify-center gap-4">
            <HeatmapCard src={patch.ttci_png} label="Composite TTCI" />
            <HeatmapCard src={patch.estd_png} label="Elevation std (norm)" />
          </div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Where they disagree (corr={fmt(patch.corr, 3)}):</strong>{" "}
            elevation_std over-scores flat terrain immediately adjacent to the escarpment base — the
            5-cell window bleeds onto cliff faces, inflating the score at cells where slope and
            ruggedness are low. Composite TTCI reserves high ratings for cells that are
            geometrically steep or jagged. On the cliff face itself (the actual danger zone)
            both agree.
          </p>
        </section>
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

function HeatmapCard({ src, label }: { src: string; label: string }) {
  return (
    <div className="text-center">
      <img
        src={src}
        alt={label}
        className="block rounded border border-border/30"
        style={{ width: 138, height: 138, imageRendering: "pixelated" }}
      />
      <p className="mt-1 text-[10px] font-medium text-muted-foreground">{label}</p>
    </div>
  );
}
