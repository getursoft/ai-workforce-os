import { TrendingUp } from "lucide-react";

export function DepartmentUseCases({
  outcomes,
  responsibilities,
  handoffNote,
}: {
  outcomes: string[];
  responsibilities: string[];
  handoffNote: string;
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
        <h2 className="text-xl font-bold text-ink">Typical Responsibilities</h2>
        <ul className="mt-5 space-y-3 text-sm leading-relaxed text-muted">
          {responsibilities.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-saffron" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-6">
        <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
          <div className="mb-4 flex items-center gap-2 text-royal">
            <TrendingUp className="h-5 w-5" aria-hidden="true" />
            <h2 className="text-xl font-bold text-ink">Business Outcomes</h2>
          </div>
          <ul className="space-y-3 text-sm leading-relaxed text-muted">
            {outcomes.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-card border border-gold/30 bg-cream/60 p-6">
          <p className="text-sm leading-relaxed text-ink/80">
            <span className="font-semibold text-royal">Human oversight: </span>
            {handoffNote}
          </p>
        </div>
      </div>
    </div>
  );
}
