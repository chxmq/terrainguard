import { X } from "lucide-react";
import { useTtci } from "@/state/ttci";
import { cn } from "@/lib/utils";

export function Toaster() {
  const { toasts, dismissToast } = useTtci();
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[3000] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex min-w-[260px] max-w-[420px] items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-sm shadow-lg backdrop-blur",
            t.type === "error" ? "border-risk-high/50"
              : t.type === "success" ? "border-risk-vlow/50" : "border-primary/40"
          )}
        >
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              t.type === "error" ? "bg-risk-high" : t.type === "success" ? "bg-risk-vlow" : "bg-primary"
            )}
          />
          <span className="flex-1 leading-snug">{t.message}</span>
          <button onClick={() => dismissToast(t.id)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
