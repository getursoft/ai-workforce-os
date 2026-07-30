import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { caseStudies } from "@/content/case-studies";

export const metadata: Metadata = defaultMetadata({
  title: "Case Studies",
  description: "Representative case studies showing how organisations use AI employees across departments.",
  path: "/resources/case-studies",
});

export default function CaseStudiesPage() {
  return (
    <>
      <PageHero
        eyebrow="Case studies"
        title="Representative Scenarios by Department"
        description="Illustrative case studies based on common patterns we see across customer organisations — not endorsements from named customers."
      />
      <section className="mx-auto max-w-5xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {caseStudies.map((study) => (
            <div key={study.slug} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
              <span className="text-xs font-semibold uppercase tracking-wide text-saffron">{study.sector}</span>
              <h2 className="mt-2 text-xl font-bold text-ink">{study.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{study.summary}</p>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Challenge</p>
                  <p className="mt-1 text-sm text-ink/80">{study.challenge}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Approach</p>
                  <p className="mt-1 text-sm text-ink/80">{study.solution}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-muted">Outcomes</p>
                  <ul className="mt-1 space-y-1 text-sm text-ink/80">
                    {study.outcome.map((item) => (
                      <li key={item}>· {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <span className="mt-5 inline-block rounded-full bg-cream px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-saffron">
                Representative scenario
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
