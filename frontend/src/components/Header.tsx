import { Moon, Sun, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useTheme } from "@/components/theme-provider";
import { useTtci } from "@/state/ttci";
import { useTools } from "@/state/tools";
import { cn } from "@/lib/utils";

export function Header() {
  const { theme, toggle } = useTheme();
  const { status, statusText, sourceLabel, isSynthetic } = useTtci();
  const { view, setView } = useTools();

  const dot =
    status === "ready" ? "bg-risk-vlow shadow-[0_0_8px] shadow-risk-vlow"
    : status === "error" ? "bg-risk-high"
    : status === "computing" || status === "connecting" ? "bg-risk-low animate-pulse"
    : "bg-muted-foreground";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/70 px-5 backdrop-blur">
      <div className="flex items-center gap-3">
        <Logo />
        <div className="leading-tight">
          <h1 className="bg-gradient-to-r from-risk-high to-risk-critical bg-clip-text text-lg font-bold text-transparent">
            Terrain Guard
          </h1>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            TTCI Assessment
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        {/* 2D / 3D view toggle */}
        <div className="flex items-center rounded-full border border-border bg-secondary/50 p-0.5 font-mono text-xs font-bold">
          {(["2d", "3d"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-full px-3 py-1 transition-colors",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              )}
            >
              {v.toUpperCase()}
            </button>
          ))}
        </div>
        {sourceLabel && (
          <div className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary md:flex">
            <Database className="h-3 w-3" />
            <span className="max-w-[260px] truncate">{sourceLabel}</span>
          </div>
        )}
        {isSynthetic && (
          <div className="rounded-full border border-risk-low/40 bg-risk-low/10 px-3 py-1 text-[11px] font-semibold text-risk-low">
            Demo data
          </div>
        )}
        <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium">
          <span className={cn("h-2 w-2 rounded-full", dot)} />
          {statusText}
        </div>
        <Button variant="outline" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
