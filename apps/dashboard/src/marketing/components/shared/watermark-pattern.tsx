type WatermarkVariant = "mandala" | "jaali" | "waves" | "network";

interface WatermarkPatternProps {
  variant?: WatermarkVariant;
  className?: string;
}

/**
 * Purely decorative, abstract heritage-inspired line art rendered as inline SVG.
 * Kept at very low opacity via the `opacity` utility passed through `className`.
 */
export function WatermarkPattern({ variant = "mandala", className = "" }: WatermarkPatternProps) {
  return (
    <div aria-hidden="true" className={`pointer-events-none select-none overflow-hidden ${className}`}>
      {variant === "mandala" && <MandalaSvg />}
      {variant === "jaali" && <JaaliSvg />}
      {variant === "waves" && <WavesSvg />}
      {variant === "network" && <NetworkSvg />}
    </div>
  );
}

function MandalaSvg() {
  const rings = [40, 80, 120, 160, 200];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" fill="none">
      <g stroke="currentColor" strokeWidth="1">
        {rings.map((r) => (
          <circle key={r} cx="200" cy="200" r={r} />
        ))}
        {Array.from({ length: 16 }).map((_, i) => {
          const angle = (i * Math.PI) / 8;
          const x2 = (200 + 200 * Math.cos(angle)).toFixed(2);
          const y2 = (200 + 200 * Math.sin(angle)).toFixed(2);
          return <line key={i} x1="200" y1="200" x2={x2} y2={y2} />;
        })}
      </g>
    </svg>
  );
}

function JaaliSvg() {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" fill="none">
      <defs>
        <pattern id="jaali" width="40" height="40" patternUnits="userSpaceOnUse">
          <path
            d="M20 0 L40 20 L20 40 L0 20 Z"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
          <circle cx="20" cy="20" r="6" stroke="currentColor" strokeWidth="1" fill="none" />
        </pattern>
      </defs>
      <rect width="200" height="200" fill="url(#jaali)" />
    </svg>
  );
}

function WavesSvg() {
  return (
    <svg viewBox="0 0 600 200" className="h-full w-full" fill="none" preserveAspectRatio="none">
      <g stroke="currentColor" strokeWidth="1">
        {[0, 30, 60, 90, 120, 150, 180].map((y) => (
          <path
            key={y}
            d={`M0 ${y} Q 75 ${y - 25} 150 ${y} T 300 ${y} T 450 ${y} T 600 ${y}`}
          />
        ))}
      </g>
    </svg>
  );
}

function NetworkSvg() {
  const points = [
    [40, 40], [140, 20], [260, 60], [80, 140], [200, 160], [320, 120], [360, 30], [20, 200], [300, 220],
  ];
  return (
    <svg viewBox="0 0 400 260" className="h-full w-full" fill="none">
      <g stroke="currentColor" strokeWidth="1">
        {points.map(([x, y], i) => {
          const next = points[(i + 1) % points.length];
          if (!next) return null;
          const [nx, ny] = next;
          return <line key={i} x1={x} y1={y} x2={nx} y2={ny} />;
        })}
      </g>
      <g fill="currentColor">
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3" />
        ))}
      </g>
    </svg>
  );
}
