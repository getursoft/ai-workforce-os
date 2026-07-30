import { AlertTriangle } from "lucide-react";

export function LegalNotice() {
  return (
    <div className="mx-auto mb-10 flex max-w-3xl items-start gap-3 rounded-xl border border-saffron/30 bg-cream/70 p-5 text-sm text-ink/80">
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-saffron" aria-hidden="true" />
      <p>
        <span className="font-semibold text-ink">Draft placeholder — pending legal review.</span> This page is a
        structured starting point and must be reviewed and finalised by qualified legal counsel before this site is
        used in production.
      </p>
    </div>
  );
}
