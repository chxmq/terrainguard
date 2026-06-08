import { createPortal } from "react-dom";

/** Film grain + ambient depth — portaled above the app so it stays visible on all panels. */
export function AmbientChrome() {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="ambient-chrome" aria-hidden="true">
      <div className="ambient-bg" />
      <div className="grain-overlay" />
    </div>,
    document.body,
  );
}
