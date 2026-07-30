import { MessageSquareText } from "lucide-react";

export function ExampleRequests({ requests }: { requests: string[] }) {
  return (
    <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
      <h2 className="text-xl font-bold text-ink">Example Requests</h2>
      <p className="mt-1 text-sm text-muted">Representative prompts people ask this AI employee.</p>
      <ul className="mt-6 space-y-3">
        {requests.map((request) => (
          <li key={request} className="flex items-start gap-3 rounded-xl bg-cream/60 p-4">
            <MessageSquareText className="mt-0.5 h-4 w-4 flex-shrink-0 text-saffron" aria-hidden="true" />
            <span className="text-sm leading-relaxed text-ink">&ldquo;{request}&rdquo;</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
