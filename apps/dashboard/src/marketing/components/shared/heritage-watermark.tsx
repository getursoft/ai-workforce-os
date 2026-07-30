/**
 * Single, fixed background treatment shared by every public page (mounted once in
 * the root layout) so the watermark never appears to change between routes.
 */
export function HeritageWatermark() {
  return (
    <div aria-hidden="true" className="fixed inset-0 -z-10 overflow-hidden bg-ivory">
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.05] text-royal"
        aria-hidden="true"
      >
        <defs>
          <pattern id="hw-dots" width="30" height="30" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.5" fill="currentColor" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hw-dots)" />
      </svg>

      <svg
        viewBox="0 0 500 500"
        className="absolute -left-24 -top-24 h-[520px] w-[520px] text-royal opacity-[0.06]"
        fill="none"
      >
        <g stroke="currentColor" strokeWidth="1.2">
          <circle cx="250" cy="250" r="60" />
          <circle cx="250" cy="250" r="110" />
          <circle cx="250" cy="250" r="160" />
          <circle cx="250" cy="250" r="210" />
          {Array.from({ length: 24 }).map((_, i) => {
            const angle = (i * Math.PI) / 12;
            return (
              <line
                key={i}
                x1={250 + 60 * Math.cos(angle)}
                y1={250 + 60 * Math.sin(angle)}
                x2={250 + 210 * Math.cos(angle)}
                y2={250 + 210 * Math.sin(angle)}
              />
            );
          })}
        </g>
      </svg>

      <svg
        viewBox="0 0 600 260"
        preserveAspectRatio="xMaxYMax meet"
        className="absolute -bottom-4 -right-10 h-[280px] w-[640px] text-saffron opacity-[0.07]"
        fill="none"
      >
        <g stroke="currentColor" strokeWidth="1.4">
          <path d="M0 260 V150 Q40 90 80 150 V260" />
          <path d="M80 260 V120 Q140 40 200 120 V260" />
          <path d="M200 260 V160 Q230 120 260 160 V260" />
          <path d="M260 260 V90 Q340 10 420 90 V260" />
          <path d="M420 260 V170 Q450 130 480 170 V260" />
          <path d="M480 260 V140 Q540 70 600 140 V260" />
          <line x1="0" y1="260" x2="600" y2="260" />
          <circle cx="80" cy="94" r="6" />
          <circle cx="340" cy="30" r="7" />
          <circle cx="540" cy="86" r="6" />
        </g>
      </svg>
    </div>
  );
}
