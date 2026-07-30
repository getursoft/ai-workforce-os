import { CheckCircle2 } from "lucide-react";

export function CapabilityList({
  title,
  items,
}: {
  title: string;
  items: { title: string; description: string }[];
}) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-ink sm:text-3xl">{title}</h2>
      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.title} className="flex gap-3 rounded-xl border border-royal/10 bg-white p-5 shadow-soft">
            <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" aria-hidden="true" />
            <div>
              <p className="font-semibold text-ink">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
