import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { docSections } from "@/content/documentation";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Documentation",
  description: "Guides for configuring AI employees, knowledge, integrations, governance and analytics on Krevia.ai.",
  path: "/resources/documentation",
});

export default function DocumentationPage() {
  return (
    <>
      <PageHero
        eyebrow="Documentation"
        title="Guides for Configuring Your AI Workforce"
        description="A landing view of the documentation available once you're set up on Krevia.ai."
      />
      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {docSections.map((section) => (
            <div key={section.title} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
              <h2 className="text-lg font-bold text-ink">{section.title}</h2>
              <p className="mt-2 text-sm text-muted">{section.description}</p>
              <ul className="mt-4 space-y-2 text-sm text-ink/80">
                {section.topics.map((topic) => (
                  <li key={topic} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-saffron" aria-hidden="true" />
                    {topic}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-8 rounded-3xl border border-gold/30 bg-cream/60 p-8 text-center">
          <h2 className="text-2xl font-bold text-ink">Full documentation is available inside your workspace</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Step-by-step guides, API references and configuration walkthroughs are available once your organisation
            is set up. Book a demo to get access.
          </p>
          <div className="mt-6">
            <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
