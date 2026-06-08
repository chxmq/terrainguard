import { Database, Moon, Sun } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useTtci } from "@/state/ttci";
import { cn } from "@/lib/utils";
import { useThemeMode } from "@/hooks/useThemeMode";

export function Header() {
  const { status, statusText, sourceLabel, isSynthetic, activeRegion } = useTtci();

  const subtitle = !activeRegion
    ? "Select a terrain area to begin"
    : status === "ready"
    ? "Click the map to inspect terrain risk"
    : statusText;

  const { isDark, toggleLightDarkMode } = useThemeMode();

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
            <span className="max-w-[200px] truncate font-mono text-2xs text-body">{sourceLabel}</span>
          </span>
        )}

        {isSynthetic && (
          <span className="text-caps rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-200/90">
            Demo
          </span>
        )}

        <div
          className={cn(
            "text-ui flex items-center gap-1.5 rounded-md border px-2.5 py-1",
            status === "ready"
              ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
              : status === "error"
              ? "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-200"
              : "border-border bg-secondary text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              status === "ready" ? "bg-emerald-600 dark:bg-emerald-400"
              : status === "error" ? "bg-red-600 dark:bg-red-400"
              : "bg-muted-foreground animate-pulse",
            )}
          />
          {statusText}
        </div>

        <button
          type="button"
          onClick={(e) => toggleLightDarkMode({ x: e.clientX, y: e.clientY })}
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-secondary/80 hover:text-foreground"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
