import { Sparkles } from "lucide-react";

export function SuggestedPrompts({
  prompts,
  onSelect,
}: {
  prompts: string[];
  onSelect: (prompt: string) => void;
}) {
  if (prompts.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Sparkles className="h-3.5 w-3.5 text-saffron" aria-hidden="true" />
        Suggested questions
      </p>
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onSelect(prompt)}
            className="focus-ring rounded-full border border-royal/15 bg-white px-3.5 py-1.5 text-left text-xs font-medium text-royal transition-colors hover:border-saffron/40 hover:bg-cream/60"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
