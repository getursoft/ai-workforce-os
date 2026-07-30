import type { Metadata } from "next";
import { Mail, Phone, MapPin } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { ContactForm } from "@/components/forms/contact-form";
import { ButtonLink } from "@/components/shared/button-link";
import { siteConfig } from "@/content/site";

export const metadata: Metadata = defaultMetadata({
  title: "Contact Us",
  description: "Get in touch with the AI Workforce OS team about AI employees, enterprise deployment, partnerships or press.",
  path: "/contact",
});

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact us"
        title="Let's Talk About Your AI Workforce"
        description="Whether you have a question, a partnership idea, or want to explore AI employees for your organisation, we'd like to hear from you."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-xl font-bold text-ink">Get in Touch</h2>
            <div className="mt-6 space-y-5 text-sm">
              <ContactPoint icon={Mail} label="Email" value={siteConfig.contact.generalEmail} href={`mailto:${siteConfig.contact.generalEmail}`} />
              <ContactPoint icon={Phone} label="Phone" value={siteConfig.contact.phone} href={`tel:${siteConfig.contact.phone.replace(/\s/g, "")}`} />
              <ContactPoint icon={MapPin} label="Office" value={siteConfig.contact.address} />
            </div>
            <div className="mt-8 rounded-card border border-gold/30 bg-cream/60 p-6">
              <h3 className="font-semibold text-ink">Prefer a guided walkthrough?</h3>
              <p className="mt-2 text-sm text-muted">Book a demo and we&apos;ll configure a representative AI employee around a real use case.</p>
              <div className="mt-4">
                <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
              </div>
            </div>
          </div>

          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <ContactForm />
          </div>
        </div>
      </section>
    </>
  );
}

function ContactPoint({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof Mail;
  label: string;
  value: string;
  href?: string;
}) {
  const content = (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-royal" aria-hidden="true" />
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
        <p className="text-ink">{value}</p>
      </div>
    </div>
  );
  return href ? (
    <a href={href} className="focus-ring block rounded-md hover:text-saffron">
      {content}
    </a>
  ) : (
    content
  );
}
