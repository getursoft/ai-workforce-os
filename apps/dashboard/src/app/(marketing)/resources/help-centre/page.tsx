import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { helpTopics } from "@/content/help-centre";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Help Centre",
  description: "Answers to common account, AI employee, knowledge, billing and security questions on AI Workforce OS.",
  path: "/resources/help-centre",
});

export default function HelpCentrePage() {
  const categories = Array.from(new Set(helpTopics.map((t) => t.category)));

  return (
    <>
      <PageHero eyebrow="Help centre" title="How Can We Help?" description="Answers to the questions our support team hears most often." />
      <section className="mx-auto max-w-4xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="space-y-10">
          {categories.map((category) => (
            <div key={category}>
              <h2 className="text-lg font-bold text-ink">{category}</h2>
              <div className="mt-4 space-y-3">
                {helpTopics
                  .filter((t) => t.category === category)
                  .map((topic) => (
                    <div key={topic.question} className="rounded-xl border border-royal/10 bg-white p-5 shadow-soft">
                      <p className="font-semibold text-ink">{topic.question}</p>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted">{topic.answer}</p>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <p className="text-sm text-muted">Can&apos;t find what you&apos;re looking for?</p>
          <div className="mt-4">
            <ButtonLink href="/contact" variant="primary">Contact Support</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
