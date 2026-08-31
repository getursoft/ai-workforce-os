import type { Metadata } from "next";
import { defaultMetadata, JsonLd } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { FaqAccordion } from "@/components/shared/faq-accordion";
import { faqs } from "@/content/faqs";

export const metadata: Metadata = defaultMetadata({
  title: "Frequently Asked Questions",
  description: "Answers to common questions about Krevia.ai, AI employees, security, pricing and integrations.",
  path: "/resources/faq",
});

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

export default function FaqPage() {
  return (
    <>
      <JsonLd data={faqJsonLd} />
      <PageHero eyebrow="FAQs" title="Frequently Asked Questions" description="Everything you need to know before getting started." />
      <section className="mx-auto max-w-3xl px-4 py-7 sm:px-6 lg:px-8">
        <FaqAccordion items={faqs} />
      </section>
    </>
  );
}
