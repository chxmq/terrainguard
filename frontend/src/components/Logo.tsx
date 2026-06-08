/** Terrain Guard logo — the layered-peak mark carried over from the original UI. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d="M16 2L4 28h24L16 2z" fill="url(#tg-grad1)" opacity="0.9" />
      <path d="M16 8L8 26h16L16 8z" fill="url(#tg-grad2)" opacity="0.7" />
      <path d="M16 14L12 24h8L16 14z" fill="currentColor" opacity="0.5" />
      <defs>
        <linearGradient id="tg-grad1" x1="4" y1="28" x2="28" y2="2">
          <stop stopColor="#e74c3c" />
          <stop offset="1" stopColor="#8e44ad" />
        </linearGradient>
        <linearGradient id="tg-grad2" x1="8" y1="26" x2="24" y2="8">
          <stop stopColor="#f39c12" />
          <stop offset="1" stopColor="#e74c3c" />
        </linearGradient>
      </defs>
    </svg>
  );
}
