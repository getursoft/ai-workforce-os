import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { DemoForm } from "@/components/forms/demo-form";

export const metadata: Metadata = defaultMetadata({
  title: "Book a Demo",
  description: "Book a guided demo of Krevia.ai, configured around a real use case from your organisation.",
  path: "/book-demo",
});

const expectations = [
  "A walkthrough of AI employees relevant to your department",
  "A look at how organisational knowledge and integrations connect",
  "A discussion of governance, approvals and security controls",
  "Clear next steps based on your organisation's needs",
];

export default function BookDemoPage() {
  return (
    <>
      <PageHero
        eyebrow="Book a demo"
        title="See Krevia.ai Configured Around Your Business"
        description="A guided, no-pressure walkthrough tailored to the departments and workflows that matter most to you."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-xl font-bold text-ink">What to Expect</h2>
            <ul className="mt-6 space-y-4">
              {expectations.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-relaxed text-muted">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-8 rounded-card border border-royal/10 bg-ivory/60 p-6 text-sm leading-relaxed text-muted">
              Demos typically run 30–45 minutes. We recommend including anyone who would own the AI employee day
              to day, alongside a technical stakeholder if integrations are in scope.
            </div>
          </div>

          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <DemoForm />
          </div>
        </div>
      </section>
    </>
  );
}
