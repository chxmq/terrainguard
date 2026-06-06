import { useEffect, useRef } from "react";
import type { MsaSector, ProfilePoint, TawsLookahead } from "@/lib/api";

const M_PER_FT = 0.3048;

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, rect.width, rect.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

export function MsaProfileChart({ profile, sectors }: { profile: ProfilePoint[]; sectors: MsaSector[] }) {
  const ref = useCanvas((ctx, W, H) => {
    const pad = { top: 16, right: 50, bottom: 26, left: 50 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    ctx.clearRect(0, 0, W, H);
    if (!profile.length) return;

    const dists = profile.map((p) => p.distance_km);
    const elevs = profile.map((p) => p.elevation_m);
    const maxDist = Math.max(...dists) || 1;
    const msaM = sectors.map((s) => s.msa_m).filter((v) => Number.isFinite(v));
    const minE = Math.min(...elevs) - 200;
    const maxE = Math.max(...elevs, ...msaM) + 300;
    const span = maxE - minE || 1;
    const xS = (km: number) => pad.left + (km / maxDist) * plotW;
    const yS = (m: number) => pad.top + plotH - ((m - minE) / span) * plotH;

    ctx.font = '9px "JetBrains Mono", monospace';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.strokeStyle = "rgba(128,128,128,0.18)";
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const m = maxE - (i / 4) * span;
      ctx.fillStyle = "#94a3b8"; ctx.textAlign = "right";
      ctx.fillText(`${m.toFixed(0)}m`, pad.left - 5, y + 3);
      ctx.textAlign = "left";
      ctx.fillText(`${(m / M_PER_FT).toFixed(0)}ft`, W - pad.right + 5, y + 3);
    }

    ctx.beginPath(); ctx.moveTo(xS(dists[0]), yS(minE));
    profile.forEach((p) => ctx.lineTo(xS(p.distance_km), yS(p.elevation_m)));
    ctx.lineTo(xS(dists[dists.length - 1]), yS(minE)); ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
    g.addColorStop(0, "rgba(231,76,60,0.40)"); g.addColorStop(1, "rgba(46,204,113,0.05)");
    ctx.fillStyle = g; ctx.fill();

    ctx.beginPath();
    profile.forEach((p, i) => { const x = xS(p.distance_km), y = yS(p.elevation_m); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#e74c3c"; ctx.lineWidth = 1.5; ctx.stroke();

    let cursor = 0;
    ctx.font = '9px "JetBrains Mono", monospace';
    sectors.forEach((s) => {
      const x1 = xS(cursor); cursor += s.distance_km; const x2 = xS(cursor);
      const y = yS(s.msa_m);
      if (y <= pad.top || y >= H - pad.bottom) return;
      ctx.beginPath(); ctx.setLineDash([6, 4]); ctx.moveTo(x1, y); ctx.lineTo(x2, y);
      ctx.strokeStyle = "rgba(59,130,246,0.85)"; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#3b82f6"; ctx.textAlign = "left";
      ctx.fillText(`S${s.sector} ${Math.round(s.msa_ft)}ft`, x1 + 4, y - 4);
    });

    ctx.fillStyle = "#94a3b8"; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Cumulative distance (km)", W / 2, H - 5);
  }, [profile, sectors]);

  return <canvas ref={ref} className="h-[150px] w-full rounded-md border border-border bg-secondary/30" />;
}

export function TawsProfileChart({ result }: { result: TawsLookahead }) {
  const ref = useCanvas((ctx, W, H) => {
    const pad = { top: 14, right: 50, bottom: 24, left: 50 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;
    ctx.clearRect(0, 0, W, H);
    const prof = result.profile;
    if (!prof.length) return;

    const dists = prof.map((p) => p.distance_nm);
    const terr = prof.map((p) => p.terrain_ft);
    const path = prof.map((p) => p.path_alt_ft);
    const maxDist = Math.max(...dists) || 1;
    const minY = Math.min(...terr, ...path) - 500;
    const maxY = Math.max(...terr, ...path) + 500;
    const span = maxY - minY || 1;
    const xS = (d: number) => pad.left + (d / maxDist) * plotW;
    const yS = (ft: number) => pad.top + plotH - ((ft - minY) / span) * plotH;

    ctx.font = '9px "JetBrains Mono", monospace';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH / 4) * i;
      ctx.strokeStyle = "rgba(128,128,128,0.18)";
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      const ft = maxY - (i / 4) * span;
      ctx.fillStyle = "#94a3b8"; ctx.textAlign = "right";
      ctx.fillText(`${(ft / 1000).toFixed(1)}k`, pad.left - 5, y + 3);
      ctx.textAlign = "left";
      ctx.fillText(`${(ft * M_PER_FT).toFixed(0)}m`, W - pad.right + 5, y + 3);
    }

    ctx.beginPath(); ctx.moveTo(xS(dists[0]), yS(minY));
    prof.forEach((p) => ctx.lineTo(xS(p.distance_nm), yS(p.terrain_ft)));
    ctx.lineTo(xS(dists[dists.length - 1]), yS(minY)); ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
    g.addColorStop(0, "rgba(231,76,60,0.40)"); g.addColorStop(1, "rgba(46,204,113,0.05)");
    ctx.fillStyle = g; ctx.fill();

    ctx.beginPath();
    prof.forEach((p, i) => { const x = xS(p.distance_nm), y = yS(p.terrain_ft); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#e74c3c"; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.beginPath(); ctx.setLineDash([6, 4]);
    prof.forEach((p, i) => { const x = xS(p.distance_nm), y = yS(p.path_alt_ft); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);

    if (result.trigger) {
      ctx.fillStyle = result.alert_color;
      ctx.beginPath(); ctx.arc(xS(result.trigger.distance_nm), yS(result.trigger.terrain_ft), 4, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.fillStyle = "#94a3b8"; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Distance ahead (NM)", W / 2, H - 5);
  }, [result]);

  return <canvas ref={ref} className="h-[150px] w-full rounded-md border border-border bg-secondary/30" />;
}
