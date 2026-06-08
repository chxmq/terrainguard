import { useEffect, useState } from "react";
import { Database, Moon, Sun } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useTtci } from "@/state/ttci";
import { cn } from "@/lib/utils";

export function Header() {
  const { status, statusText, sourceLabel, isSynthetic } = useTtci();

  const [utc, setUtc] = useState(() => new Date().toISOString().slice(11, 19));
  useEffect(() => {
    const id = setInterval(() => setUtc(new Date().toISOString().slice(11, 19)), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Dark / cockpit mode toggle ──
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  };

  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border bg-card px-5">
      {/* ── Left: branding ── */}
      <div className="flex items-center gap-3">
        <Logo />
        <div className="leading-none">
          <div className="text-[15px] font-bold tracking-tight text-foreground">
            Terrain Guard
          </div>
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            TTCI Assessment
          </div>
        </div>
      </div>

      {/* ── Center: UTC clock ── */}
      <div className="flex flex-col items-center">
        <div className="font-mono text-[20px] font-bold tabular-nums text-foreground">
          {utc}
        </div>
        <div className="text-[9px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
          UTC
        </div>
      </div>

      {/* ── Right: system info + dark mode toggle ── */}
      <div className="flex items-center gap-2">
        {sourceLabel && (
          <span className="hidden items-center gap-1.5 rounded border border-border bg-secondary px-2.5 py-1 font-mono text-[10px] font-medium text-muted-foreground md:flex">
            <Database className="h-3 w-3 shrink-0" />
            <span className="max-w-[180px] truncate">{sourceLabel}</span>
          </span>
        )}

        {isSynthetic && (
          <span className="rounded border border-amber-500/60 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            Demo
          </span>
        )}

        {/* System status */}
        <div
          className={cn(
            "flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
            status === "ready"
              ? "border-emerald-500/60 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
              : status === "error"
              ? "border-red-500/60 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
              : "animate-pulse border-amber-500/60 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "ready" ? "bg-emerald-600" : status === "error" ? "bg-red-600" : "bg-amber-600",
            )}
          />
          {statusText}
        </div>

        {/* ── Night / Day toggle ── */}
        <button
          onClick={toggleDark}
          title={dark ? "Switch to Day mode" : "Switch to Night / Cockpit mode"}
          className={cn(
            "flex items-center gap-1.5 rounded border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
            dark
              ? "border-indigo-500/60 bg-indigo-950/40 text-indigo-300 hover:bg-indigo-900/50"
              : "border-border bg-secondary text-muted-foreground hover:border-primary hover:text-primary",
          )}
        >
          {dark ? (
            <><Sun className="h-3 w-3" /> Day</>
          ) : (
            <><Moon className="h-3 w-3" /> Night</>
          )}
        </button>
      </div>
    </header>
  );
}
