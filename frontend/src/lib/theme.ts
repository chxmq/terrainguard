const THEME_KEY = "terrain-guard-theme";

export type ThemeMode = "light" | "dark" | "system";

const MODE_CYCLE: ThemeMode[] = ["light", "dark", "system"];

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => { finished: Promise<void> };
};

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: "Light mode",
  dark: "Dark mode",
  system: "System theme (matches OS)",
};

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* private browsing */ }
  return "system";
}

/** Header quick-toggle: flip between light and dark (leaves system when used). */
export function toggleLightDark(isCurrentlyDark: boolean): ThemeMode {
  return isCurrentlyDark ? "light" : "dark";
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return mode === "dark";
}

export function cycleThemeMode(mode: ThemeMode): ThemeMode {
  const i = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
}

function persistThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch { /* private browsing */ }
}

function setOrigin(root: HTMLElement, point?: { x: number; y: number }) {
  const x = point?.x ?? window.innerWidth / 2;
  const y = point?.y ?? window.innerHeight / 2;
  const r = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  root.style.setProperty("--theme-x", `${x}px`);
  root.style.setProperty("--theme-y", `${y}px`);
  root.style.setProperty("--theme-r", `${r}px`);
}

function applyThemeClass(mode: ThemeMode) {
  const root = document.documentElement;
  const dark = resolveDark(mode);
  root.classList.toggle("dark", dark);
  root.dataset.theme = mode;
  persistThemeMode(mode);
}

/** Instant apply on first paint (no animation). */
export function applyThemeImmediate(mode?: ThemeMode) {
  applyThemeClass(mode ?? getThemeMode());
}

/**
 * Smooth theme switch — circular reveal from click point (View Transitions API),
 * with a cross-fade fallback when unsupported.
 */
export function setThemeModeWithTransition(mode: ThemeMode, point?: { x: number; y: number }) {
  const root = document.documentElement;
  const willDark = resolveDark(mode);
  setOrigin(root, point);
  root.dataset.themeTransition = willDark ? "to-dark" : "to-light";

  const commit = () => {
    applyThemeClass(mode);
    delete root.dataset.themeTransition;
  };

  const doc = document as DocumentWithViewTransition;
  if (!doc.startViewTransition) {
    root.classList.add("theme-transition-fallback");
    commit();
    window.setTimeout(() => root.classList.remove("theme-transition-fallback"), 750);
    return;
  }

  doc.startViewTransition(() => {
    commit();
  });
}

/** @deprecated Use getThemeMode + resolveDark */
export function readPreferDark(): boolean {
  return resolveDark(getThemeMode());
}
