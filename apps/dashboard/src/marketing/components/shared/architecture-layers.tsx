import type { LucideIcon } from "lucide-react";

interface Layer {
  title: string;
  description: string;
  items: { icon: LucideIcon; label: string }[];
}

export function ArchitectureLayers({ layers }: { layers: Layer[] }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {layers.map((layer, index) => (
        <div key={layer.title} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-lg font-bold text-ink">
              <span className="mr-2 text-saffron">{String(index + 1).padStart(2, "0")}</span>
              {layer.title}
            </h3>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">{layer.description}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {layer.items.map((item) => (
              <span
                key={item.label}
                className="inline-flex items-center gap-1.5 rounded-full bg-cream/70 px-3.5 py-1.5 text-xs font-medium text-ink"
              >
                <item.icon className="h-3.5 w-3.5 text-royal" aria-hidden="true" />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
