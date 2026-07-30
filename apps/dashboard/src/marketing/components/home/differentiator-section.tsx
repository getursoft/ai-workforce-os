import { X, Check } from "lucide-react";
import { SectionHeading } from "@/components/shared/section-heading";

const rows = [
  { point: "Grounded in your organisational knowledge", chatbot: false, employee: true },
  { point: "Remembers relevant context across conversations", chatbot: false, employee: true },
  { point: "Executes multi-step tasks through connected tools", chatbot: false, employee: true },
  { point: "Routes sensitive actions for human approval", chatbot: false, employee: true },
  { point: "Collaborates with human teams and other AI employees", chatbot: false, employee: true },
  { point: "Answers isolated questions with no organisational context", chatbot: true, employee: false },
];

export function DifferentiatorSection() {
  return (
    <section className="bg-[#FFFCF7] py-9">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Beyond chat"
          title="What Makes an AI Employee Different from a Chatbot"
          description="A basic chatbot answers questions. An AI employee gets work done — grounded in your business, connected to your tools, and accountable to your team."
        />
        <div className="mt-8 overflow-x-auto rounded-card border border-royal/10 shadow-soft">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="bg-cream/60 text-left">
                <th className="px-6 py-4 font-semibold text-ink">Capability</th>
                <th className="px-6 py-4 text-center font-semibold text-muted">Basic Chatbot</th>
                <th className="px-6 py-4 text-center font-semibold text-royal">AI Employee</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.point} className="border-t border-royal/10">
                  <td className="px-6 py-4 text-ink">{row.point}</td>
                  <td className="px-6 py-4 text-center">
                    {row.chatbot ? (
                      <Check className="mx-auto h-4 w-4 text-success" aria-label="Yes" />
                    ) : (
                      <X className="mx-auto h-4 w-4 text-muted/50" aria-label="No" />
                    )}
                  </td>
                  <td className="px-6 py-4 text-center">
                    {row.employee ? (
                      <Check className="mx-auto h-4 w-4 text-success" aria-label="Yes" />
                    ) : (
                      <X className="mx-auto h-4 w-4 text-muted/50" aria-label="No" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
