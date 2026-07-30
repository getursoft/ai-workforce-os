import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { LegalNotice } from "@/components/shared/legal-notice";
import { CookiePreferences } from "@/components/shared/cookie-preferences";

export const metadata: Metadata = defaultMetadata({
  title: "Cookie Policy",
  description: "How AI Workforce OS uses cookies, and how to manage your preferences.",
  path: "/cookies",
});

const sections = [
  { title: "1. What Are Cookies", body: "Cookies are small text files stored on your device that help websites function and remember preferences across visits." },
  { title: "2. How We Use Cookies", body: "We use strictly necessary cookies to operate the website, and may use functional and analytics cookies to understand usage and improve the experience." },
  { title: "3. Managing Preferences", body: "You can manage non-essential cookie categories using the preferences panel below. Strictly necessary cookies cannot be disabled as they are required for basic site function." },
  { title: "4. Third-Party Cookies", body: "Some analytics providers may set cookies on our behalf. We do not currently use third-party marketing or advertising cookies on this site." },
  { title: "5. Changes to This Policy", body: "We may update this policy as our cookie usage changes. Material updates will be reflected here." },
];

export default function CookiesPage() {
  return (
    <>
      <PageHero eyebrow="Legal" title="Cookie Policy" description="How we use cookies on the AI Workforce OS website." />
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
        <div className="mt-10">
          <CookiePreferences />
        </div>
      </section>
    </>
  );
}
