import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { LegalNotice } from "@/components/shared/legal-notice";
import { siteConfig } from "@/content/site";

export const metadata: Metadata = defaultMetadata({
  title: "Privacy Policy",
  description: "Draft privacy policy for Krevia.ai, pending legal review.",
  path: "/privacy",
});

const sections = [
  {
    title: "1. Introduction",
    body: `This Privacy Policy describes how ${siteConfig.legalEntity} ("we", "us") collects, uses and protects information in connection with the Krevia.ai website and platform.`,
  },
  {
    title: "2. Information We Collect",
    body: "We collect information you provide directly, such as contact details submitted through forms, account and organisation information, and usage data generated as AI employees are configured and used.",
  },
  {
    title: "3. How We Use Information",
    body: "Information is used to provide and improve the platform, respond to enquiries, operate AI employees on behalf of your organisation, and communicate updates relevant to your account.",
  },
  {
    title: "4. Organisational Data and AI Employees",
    body: "Documents, policies and conversation data connected to power your organisation's AI employees are used only for that organisation and are not used to train shared models across customers.",
  },
  {
    title: "5. Data Sharing",
    body: "We do not sell personal information. Information may be shared with service providers who help us operate the platform, subject to confidentiality obligations.",
  },
  {
    title: "6. Data Retention",
    body: "Data is retained for as long as necessary to provide the service, with configurable retention controls available to organisation administrators.",
  },
  {
    title: "7. Your Rights",
    body: "Depending on your jurisdiction, you may have rights to access, correct or delete personal information. Requests can be made through our Contact page.",
  },
  {
    title: "8. Cookies",
    body: "The website uses cookies as described in our Cookie Policy.",
  },
  {
    title: "9. Changes to This Policy",
    body: "We may update this policy from time to time. Material changes will be communicated through the website.",
  },
  {
    title: "10. Contact Us",
    body: `Questions about this policy can be directed to ${siteConfig.contact.generalEmail}.`,
  },
];

export default function PrivacyPage() {
  return (
    <>
      <PageHero eyebrow="Legal" title="Privacy Policy" description="How we handle information across the Krevia.ai website and platform." />
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
