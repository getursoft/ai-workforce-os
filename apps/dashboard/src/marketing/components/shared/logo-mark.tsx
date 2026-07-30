export function LogoMark({ className = "h-11 w-11" }: { className?: string }) {
  return (
    <svg viewBox="0 0 44 44" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="43" height="43" rx="11" fill="#031B46" stroke="#F5B942" strokeWidth="1" />
      <g fill="none" stroke="#F5B942" strokeWidth="1.3">
        <path d="M22 6 L25.5 15.5 L35 15.5 L27 21.3 L30 31 L22 25 L14 31 L17 21.3 L9 15.5 L18.5 15.5 Z" />
        <circle cx="22" cy="22" r="5.5" />
      </g>
      <circle cx="22" cy="22" r="2.2" fill="#F28C00" />
    </svg>
  );
}
