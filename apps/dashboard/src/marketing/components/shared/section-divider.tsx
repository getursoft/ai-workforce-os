type DividerVariant = "line" | "fade" | "mandala";

interface SectionDividerProps {
  variant?: DividerVariant;
  className?: string;
}

/**
 * Purely decorative rhythm break between major sections — an alternative to
 * relying on whitespace alone. Keep opacity within the 2-5% range site-wide.
 */
export function SectionDivider({ variant = "line", className = "" }: SectionDividerProps) {
  if (variant === "fade") {
    return (
      <div
        aria-hidden="true"
        className={`pointer-events-none h-px w-full bg-[radial-gradient(ellipse_at_center,rgba(242,140,0,0.15)_0%,transparent_70%)] ${className}`}
      />
    );
  }

  if (variant === "mandala") {
    return (
      <div aria-hidden="true" className={`pointer-events-none relative flex justify-center ${className}`}>
        <svg viewBox="0 0 120 24" className="h-6 w-32 text-royal opacity-[0.05]" fill="none">
          <g stroke="currentColor" strokeWidth="1">
            <circle cx="60" cy="12" r="6" />
            <circle cx="60" cy="12" r="11" />
            <line x1="0" y1="12" x2="46" y2="12" />
            <line x1="74" y1="12" x2="120" y2="12" />
          </g>
        </svg>
      </div>
    );
  }

  return (
    <div aria-hidden="true" className={`pointer-events-none flex justify-center ${className}`}>
      <span className="h-px w-24 bg-saffron/[0.15]" />
    </div>
  );
}
