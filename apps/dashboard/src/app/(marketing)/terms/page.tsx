import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { LegalNotice } from "@/components/shared/legal-notice";
import { siteConfig } from "@/content/site";

export const metadata: Metadata = defaultMetadata({
  title: "Terms of Service",
  description: "Draft terms of service for Krevia.ai, pending legal review.",
  path: "/terms",
});

const sections = [
  {
    title: "1. Acceptance of Terms",
    body: `By accessing or using the Krevia.ai website or platform, you agree to be bound by these Terms of Service and any applicable order form agreed with ${siteConfig.legalEntity}.`,
  },
  {
    title: "2. Description of Service",
    body: "Krevia.ai provides a platform for configuring and operating AI employees that assist with business tasks, grounded in customer-provided knowledge and connected systems.",
  },
  {
    title: "3. Customer Responsibilities",
    body: "Customers are responsible for the accuracy of data and knowledge sources they connect, for configuring appropriate approval controls, and for reviewing AI employee outputs before relying on them for consequential decisions.",
  },
  {
    title: "4. Acceptable Use",
    body: "The platform may not be used for unlawful purposes, to violate the rights of others, or in ways that circumvent configured approval and governance controls.",
  },
  {
    title: "5. AI Output Disclaimer",
    body: "AI employees provide assistance based on configured knowledge sources and are not a substitute for professional, legal, financial or medical advice. Sensitive or high-impact actions require human review as configured by your organisation.",
  },
  {
    title: "6. Availability",
    body: "We aim to provide reliable access to the platform but do not guarantee uninterrupted availability. Planned maintenance and incidents will be communicated where practical.",
  },
  {
    title: "7. Fees",
    body: "Fees are governed by the order form or plan agreed between the customer and Krevia.ai.",
  },
  {
    title: "8. Limitation of Liability",
    body: "To the maximum extent permitted by law, Krevia.ai shall not be liable for indirect, incidental or consequential damages arising from use of the platform.",
  },
  {
    title: "9. Termination",
    body: "Either party may terminate an agreement in accordance with the terms of the applicable order form.",
  },
  {
    title: "10. Changes to These Terms",
    body: "We may update these terms from time to time. Continued use of the platform after changes constitutes acceptance of the revised terms.",
  },
  {
    title: "11. Contact",
    body: `Questions about these terms can be directed to ${siteConfig.contact.generalEmail}.`,
  },
];

export default function TermsPage() {
  return (
    <>
      <PageHero eyebrow="Legal" title="Terms of Service" description="The terms governing use of the Krevia.ai website and platform." />
      <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <LegalNotice />
        <div className="space-y-8">
          {sections.map((section) => (
            <div key={section.title}>
              <h2 className="text-lg font-bold text-ink">{section.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{section.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
