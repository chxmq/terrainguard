import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { useTtci, riskColor } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { Button } from "@/components/ui/button";
import { MsaProfileChart } from "@/components/charts";
import { fmt, fmtInt } from "@/lib/utils";

export function MsaPanel() {
  const { activeRegion, riskLevels, toast } = useTtci();
  const { mode, setMode, routeWaypoints, setRouteWaypoints, msaSectors, setMsaSectors, msaProfile, setMsaProfile } = useTools();
  const [busy, setBusy] = useState(false);

  const drawing = mode === "draw-route";
  const canCalc = routeWaypoints.length >= 2 && !busy;

  const clear = () => { setRouteWaypoints([]); setMsaSectors([]); setMsaProfile([]); if (drawing) setMode("idle"); };

  const calculate = async () => {
    if (routeWaypoints.length < 2) return;
    setBusy(true);
    try {
      const wp = routeWaypoints.map(([la, lo]) => [la, lo]);
      const [m, p] = await Promise.all([api.msaCalculate(wp), api.msaProfile(wp)]);
      setMsaSectors(m.sectors); setMsaProfile(p.profile);
    } catch (err) {
      toast((err as Error).message || "MSA calculation failed.", "error");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Draw a flight route, then compute the Minimum Safe Altitude per leg (1000 ft obstacle clearance, 5 NM buffer).
        {!activeRegion && " Select an area first."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={drawing ? "secondary" : "default"} disabled={!activeRegion} onClick={() => setMode(drawing ? "idle" : "draw-route")}>
          <Pencil className="h-3.5 w-3.5" /> {drawing ? "Click map to add…" : "Draw Route"}
        </Button>
        <Button size="sm" variant="outline" onClick={clear}>Clear</Button>
        <Button size="sm" disabled={!canCalc} onClick={calculate}>{busy ? "Calculating…" : "Calculate MSA"}</Button>
      </div>
      <div className="text-xs text-muted-foreground">
        {routeWaypoints.length === 0 ? "No active route" : `Route — ${routeWaypoints.length} waypoint${routeWaypoints.length === 1 ? "" : "s"}`}
      </div>

      {msaSectors.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-secondary/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5 text-left">Sec</th>
                <th className="px-2 py-1.5 text-left">Dist</th>
                <th className="px-2 py-1.5 text-left">MSA</th>
                <th className="px-2 py-1.5 text-left">TTCI</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {msaSectors.map((s) => (
                <tr key={s.sector} className="border-t border-border">
                  <td className="px-2 py-1.5"><span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">S{s.sector}</span></td>
                  <td className="px-2 py-1.5">{fmt(s.distance_nm, 1)} NM</td>
                  <td className="px-2 py-1.5 font-semibold">{fmtInt(s.msa_ft)} ft</td>
                  <td className="px-2 py-1.5" style={{ color: s.ttci ? riskColor(riskLevels, s.ttci.mean) : undefined }}>
                    {s.ttci ? fmt(s.ttci.mean, 3) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msaProfile.length > 0 && (
        <div>
          <h3 className="mb-2 text-[13px] font-bold">Elevation Profile</h3>
          <MsaProfileChart profile={msaProfile} sectors={msaSectors} />
        </div>
      )}
    </div>
  );
}
