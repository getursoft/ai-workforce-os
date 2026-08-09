import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { FaqAccordion } from "@/components/shared/faq-accordion";
import { faqs } from "@/content/faqs";

export const metadata: Metadata = defaultMetadata({
  title: "Frequently Asked Questions",
  description: "Answers to common questions about Krevia.ai, AI employees, security, pricing and integrations.",
  path: "/resources/faq",
});

export default function FaqPage() {
  return (
    <>
      <PageHero eyebrow="FAQs" title="Frequently Asked Questions" description="Everything you need to know before getting started." />
      <section className="mx-auto max-w-3xl px-4 py-7 sm:px-6 lg:px-8">
        <FaqAccordion items={faqs} />
      </section>
    </>
  );
}
