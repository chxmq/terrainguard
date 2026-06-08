import { Database } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useTtci } from "@/state/ttci";
import { cn } from "@/lib/utils";

export function Header() {
  const { status, statusText, sourceLabel, isSynthetic, activeRegion } = useTtci();

  const subtitle = !activeRegion
    ? "Select a terrain area to begin"
    : status === "ready"
    ? "Click the map to inspect terrain risk"
    : statusText;

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border bg-card px-5">
      <div className="flex items-center gap-3">
        <Logo size={32} />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">
            Terrain Guard
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {sourceLabel && (
          <span className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-[11px] text-muted-foreground md:flex">
            <Database className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[200px] truncate">{sourceLabel}</span>
          </span>
        )}

        {isSynthetic && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-300">
            Demo
          </span>
        )}

        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium",
            status === "ready"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : status === "error"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : "border-border bg-secondary text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "ready" ? "bg-emerald-500"
              : status === "error" ? "bg-red-500"
              : "bg-muted-foreground animate-pulse",
            )}
          />
          {statusText}
        </div>
      </div>
    </header>
  );
}
