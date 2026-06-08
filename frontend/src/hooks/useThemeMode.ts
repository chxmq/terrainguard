import { useCallback, useEffect, useState } from "react";
import {
  getThemeMode,
  resolveDark,
  setThemeModeWithTransition,
  toggleLightDark,
  type ThemeMode,
} from "@/lib/theme";

function readIsDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());
  const [isDark, setIsDark] = useState(() => resolveDark(getThemeMode()));

  useEffect(() => {
    const sync = () => {
      setMode(getThemeMode());
      setIsDark(readIsDark());
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (getThemeMode() === "system") sync();
    };
    mq.addEventListener("change", onSystemChange);

    return () => {
      observer.disconnect();
      mq.removeEventListener("change", onSystemChange);
    };
  }, []);

  const setModeWithTransition = useCallback((next: ThemeMode, point?: { x: number; y: number }) => {
    setMode(next);
    setIsDark(resolveDark(next));
    setThemeModeWithTransition(next, point);
  }, []);

  const toggleLightDarkMode = useCallback((point?: { x: number; y: number }) => {
    setModeWithTransition(toggleLightDark(readIsDark()), point);
  }, [setModeWithTransition]);

  return { mode, isDark, setModeWithTransition, toggleLightDarkMode };
}
