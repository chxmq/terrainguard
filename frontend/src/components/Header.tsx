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
          <div className="text-title">Terrain Guard</div>
          <div className="text-subtitle mt-0.5">{subtitle}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {sourceLabel && (
          <span className="hidden items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 md:flex">
            <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[200px] truncate text-body">{sourceLabel}</span>
          </span>
        )}

        {isSynthetic && (
          <span className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200/90">
            Demo
          </span>
        )}

        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium",
            status === "ready"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
              : status === "error"
              ? "border-red-500/35 bg-red-500/10 text-red-200"
              : "border-border bg-secondary text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "ready" ? "bg-emerald-400"
              : status === "error" ? "bg-red-400"
              : "bg-muted-foreground animate-pulse",
            )}
          />
          {statusText}
        </div>
      </div>
    </header>
  );
}
