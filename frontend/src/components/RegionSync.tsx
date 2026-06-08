import { useEffect, useRef } from "react";
import { useTtci, type ActiveRegion } from "@/state/ttci";
import { useTools } from "@/state/tools";

function regionKey(r: ActiveRegion): string {
  return `${r.south},${r.north},${r.west},${r.east},${r.zoom},${r.source}`;
}

/** Keep tools state and DEM preference aligned when the active region changes. */
export function RegionSync() {
  const { activeRegion, setLastQuery } = useTtci();
  const { resetForNewRegion, setDemSource } = useTools();
  const prevKey = useRef<string | null>(null);

  useEffect(() => {
    if (!activeRegion) return;
    const key = regionKey(activeRegion);
    if (prevKey.current && prevKey.current !== key) {
      resetForNewRegion();
      setLastQuery(null);
      setDemSource(activeRegion.source);
    }
    prevKey.current = key;
  }, [activeRegion, resetForNewRegion, setDemSource, setLastQuery]);

  return null;
}
