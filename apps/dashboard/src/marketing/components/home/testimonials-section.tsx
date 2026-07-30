import { SectionHeading } from "@/components/shared/section-heading";

const scenarios = [
  {
    org: "Mid-sized travel and holidays company",
    quote:
      "\"Our travel desk fields dozens of itinerary requests a day. An AI employee handling the first draft means our team now spends its time on the trips that need a human touch.\"",
    outcome: "Faster first response on trip enquiries",
  },
  {
    org: "Enterprise HR shared-services team",
    quote:
      "\"Most of what reaches HR is repeatable — leave balances, policy questions, onboarding steps. Handling that volume with an AI employee freed our HR team for the conversations that actually need them.\"",
    outcome: "Reduced repetitive query volume for HR staff",
  },
  {
    org: "B2B software sales team",
    quote:
      "\"Reps used to lose the first hour of every day on manual lead research. Having that context prepared before each call changed how our mornings look.\"",
    outcome: "Reps better prepared for every meeting",
  },
];

export function TestimonialsSection() {
  return (
    <section className="bg-[#FFF9F2] py-9">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Representative use cases"
          title="How Teams Use AI Employees"
          description="Illustrative scenarios based on common patterns we see across customer organisations."
        />
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {scenarios.map((item) => (
            <div key={item.org} className="flex flex-col rounded-card border border-royal/10 bg-ivory/60 p-6">
              <p className="text-sm leading-relaxed text-ink/90">{item.quote}</p>
              <div className="mt-4 border-t border-royal/10 pt-3">
                <p className="text-sm font-semibold text-royal">{item.org}</p>
                <p className="text-xs text-muted">{item.outcome}</p>
              </div>
              <span className="mt-3 inline-block w-fit rounded-full bg-cream px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-saffron">
                Representative example
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
