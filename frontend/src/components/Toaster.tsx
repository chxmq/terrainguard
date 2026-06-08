import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTtci } from "@/state/ttci";
import { cn } from "@/lib/utils";

export function Toaster() {
  const { toasts, dismissToast } = useTtci();

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-5 left-5 z-[10100] flex w-[min(420px,calc(100vw-2.5rem))] flex-col-reverse items-start gap-2"
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex w-full min-w-[240px] items-start gap-3 panel-float px-3.5 py-2.5 text-sm shadow-lg",
            t.type === "error" ? "border-risk-high/40"
              : t.type === "success" ? "border-emerald-500/30" : "border-border",
          )}
        >
          <span
            className={cn(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              t.type === "error" ? "bg-risk-high"
              : t.type === "success" ? "bg-emerald-500" : "bg-foreground",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 leading-snug",
              t.type === "error" ? "text-risk-high"
              : t.type === "success" ? "text-emerald-400" : "text-foreground",
            )}
          >
            {t.message}
          </span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
