import { useEffect } from "react";
import { applyThemeImmediate, getThemeMode } from "@/lib/theme";

/** Applies saved theme on load and reacts to OS changes in system mode. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyThemeImmediate(getThemeMode());

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (getThemeMode() === "system") applyThemeImmediate("system");
    };
    mq.addEventListener("change", onSystemChange);
    return () => mq.removeEventListener("change", onSystemChange);
  }, []);

  return children;
}
