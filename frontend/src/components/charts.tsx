import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { MsaSector, ProfilePoint, TawsLookahead } from "@/lib/api";

const M_PER_FT = 0.3048;

function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: unknown[],
) {
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

interface MsaProfileProps {
  profile: ProfilePoint[];
  sectors: MsaSector[];
  /** Distance along route (km) for the animated playhead. */
  flyDistKm?: number | null;
  className?: string;
}

export function MsaProfileChart({ profile, sectors, flyDistKm, className }: MsaProfileProps) {
  const ref = useCanvas(
    (ctx, W, H) => {
      const pad = { top: 20, right: 52, bottom: 28, left: 54 };
      const plotW = W - pad.left - pad.right;
      const plotH = H - pad.top - pad.bottom;
      ctx.clearRect(0, 0, W, H);
      if (!profile.length) return;

      const dists = profile.map((p) => p.distance_km);
      const elevs = profile.map((p) => p.elevation_m);
      const maxDist = Math.max(...dists) || 1;
      const msaM = sectors.map((s) => s.msa_m).filter((v) => Number.isFinite(v));
      const minE = Math.min(...elevs) - 200;
      const maxE = Math.max(...elevs, ...msaM) + 400;
      const span = maxE - minE || 1;
      const xS = (km: number) => pad.left + (km / maxDist) * plotW;
      const yS = (m: number) => pad.top + plotH - ((m - minE) / span) * plotH;

      // Grid lines + axis labels
      ctx.font = '9px "JetBrains Mono", monospace';
      for (let i = 0; i <= 5; i++) {
        const y = pad.top + (plotH / 5) * i;
        ctx.strokeStyle = "rgba(128,128,128,0.15)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        const m = maxE - (i / 5) * span;
        ctx.fillStyle = "#94a3b8";
        ctx.textAlign = "right";
        ctx.fillText(`${Math.round(m).toLocaleString()}m`, pad.left - 5, y + 3);
        ctx.textAlign = "left";
        ctx.fillText(`${Math.round(m / M_PER_FT).toLocaleString()}ft`, W - pad.right + 5, y + 3);
      }

      // Terrain fill (gradient: warm at top, transparent at bottom)
      ctx.beginPath();
      ctx.moveTo(xS(dists[0]), yS(minE));
      profile.forEach((p) => ctx.lineTo(xS(p.distance_km), yS(p.elevation_m)));
      ctx.lineTo(xS(dists[dists.length - 1]), yS(minE));
      ctx.closePath();
      const terrainGrad = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
      terrainGrad.addColorStop(0, "rgba(231,76,60,0.55)");
      terrainGrad.addColorStop(1, "rgba(231,76,60,0.08)");
      ctx.fillStyle = terrainGrad;
      ctx.fill();

      // Terrain outline
      ctx.beginPath();
      profile.forEach((p, i) => {
        const x = xS(p.distance_km), y = yS(p.elevation_m);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = 2;
      ctx.stroke();

      // MSA clearance band: blue fill between terrain profile and MSA ceiling per sector
      let cursor = 0;
      sectors.forEach((s) => {
        const secStart = cursor;
        cursor += s.distance_km;
        const secEnd = cursor;

        // Profile points within this sector (inclusive of boundaries)
        const pts = profile.filter(
          (p) => p.distance_km >= secStart - 0.001 && p.distance_km <= secEnd + 0.001,
        );
        if (!pts.length) return;

        const msaY = yS(s.msa_m);
        // Draw the clearance band (MSA line down to terrain, back)
        ctx.beginPath();
        ctx.moveTo(xS(pts[0].distance_km), msaY);
        ctx.lineTo(xS(pts[pts.length - 1].distance_km), msaY);
        for (let i = pts.length - 1; i >= 0; i--) {
          ctx.lineTo(xS(pts[i].distance_km), yS(pts[i].elevation_m));
        }
        ctx.closePath();
        ctx.fillStyle = "rgba(59,130,246,0.13)";
        ctx.fill();
      });

      // MSA line + label per sector
      cursor = 0;
      ctx.font = '9px "JetBrains Mono", monospace';
      sectors.forEach((s) => {
        const x1 = xS(cursor);
        cursor += s.distance_km;
        const x2 = xS(cursor);
        const y = yS(s.msa_m);
        if (y <= pad.top || y >= H - pad.bottom) return;

        // Dashed MSA line
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.strokeStyle = "rgba(96,165,250,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        // Label pill
        const label = `MSA ${Math.round(s.msa_ft).toLocaleString()}ft`;
        const lw = ctx.measureText(label).width + 8;
        const lx = x1 + 4;
        const ly = y - 14;
        ctx.fillStyle = "rgba(59,130,246,0.25)";
        ctx.beginPath();
        ctx.roundRect?.(lx, ly, lw, 13, 3);
        ctx.fill();
        ctx.fillStyle = "#93c5fd";
        ctx.textAlign = "left";
        ctx.fillText(label, lx + 4, ly + 10);
      });

      // Animated playhead
      if (flyDistKm != null && flyDistKm <= maxDist) {
        const x = xS(flyDistKm);

        // Vertical guide line
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        // Find nearest terrain elevation
        const nearest = profile.reduce((best, p) =>
          Math.abs(p.distance_km - flyDistKm) < Math.abs(best.distance_km - flyDistKm) ? p : best,
        );
        const dotY = yS(nearest.elevation_m);

        // Glow ring
        ctx.beginPath();
        ctx.arc(x, dotY, 7, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.fill();

        // Terrain dot
        ctx.beginPath();
        ctx.arc(x, dotY, 4, 0, 2 * Math.PI);
        ctx.fillStyle = "#fff";
        ctx.fill();

        // Aircraft icon above the playhead
        ctx.font = "13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.fillText("✈", x, pad.top + 13);
      }

      // X-axis label
      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Distance (km)", W / 2, H - 6);
    },
    [profile, sectors, flyDistKm],
  );

  return (
    <canvas
      ref={ref}
      className={cn("w-full rounded-md border border-border bg-secondary/30", className ?? "h-[260px]")}
    />
  );
}

export function TawsProfileChart({ result }: { result: TawsLookahead }) {
  const ref = useCanvas(
    (ctx, W, H) => {
      const pad = { top: 16, right: 52, bottom: 26, left: 52 };
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
        ctx.fillStyle = "#94a3b8";
        ctx.textAlign = "right";
        ctx.fillText(`${(ft / 1000).toFixed(1)}k`, pad.left - 5, y + 3);
        ctx.textAlign = "left";
        ctx.fillText(`${(ft * M_PER_FT).toFixed(0)}m`, W - pad.right + 5, y + 3);
      }

      ctx.beginPath();
      ctx.moveTo(xS(dists[0]), yS(minY));
      prof.forEach((p) => ctx.lineTo(xS(p.distance_nm), yS(p.terrain_ft)));
      ctx.lineTo(xS(dists[dists.length - 1]), yS(minY));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.top, 0, H - pad.bottom);
      g.addColorStop(0, "rgba(231,76,60,0.40)");
      g.addColorStop(1, "rgba(46,204,113,0.05)");
      ctx.fillStyle = g;
      ctx.fill();

      ctx.beginPath();
      prof.forEach((p, i) => {
        const x = xS(p.distance_nm), y = yS(p.terrain_ft);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      prof.forEach((p, i) => {
        const x = xS(p.distance_nm), y = yS(p.path_alt_ft);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      if (result.trigger) {
        ctx.fillStyle = result.alert_color;
        ctx.beginPath();
        ctx.arc(xS(result.trigger.distance_nm), yS(result.trigger.terrain_ft), 4, 0, 2 * Math.PI);
        ctx.fill();
      }

      ctx.fillStyle = "#94a3b8";
      ctx.font = "10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Distance ahead (NM)", W / 2, H - 5);
    },
    [result],
  );

  return <canvas ref={ref} className="h-[200px] w-full rounded-md border border-border bg-secondary/30" />;
}
