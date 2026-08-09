import type { Metadata } from "next";
import { Target, Eye, Compass, ShieldCheck, Handshake, Users } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "About Us",
  description:
    "Learn about Krevia.ai's mission, product philosophy and responsible AI principles — building AI employees that extend human teams.",
  path: "/about",
});

const principles = [
  { icon: ShieldCheck, title: "Human Oversight by Design", description: "Sensitive and high-impact actions are always routed to a human before they run." },
  { icon: Handshake, title: "Collaborators, Not Replacements", description: "AI employees are built to support and extend human teams, not operate in isolation." },
  { icon: Compass, title: "Honesty About Limits", description: "When a confirmed answer isn't available, our AI employees say so instead of guessing." },
  { icon: Users, title: "Built With Customers", description: "We shape every AI employee deployment around real workflows, in partnership with the people using it." },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About us"
        title="Building the Operating System for AI Employees"
        description="We started Krevia.ai to help organisations put AI to work responsibly — as a colleague that extends teams, not a black box that replaces them."
      />

      <section className="mx-auto max-w-5xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2">
          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <Target className="h-7 w-7 text-saffron" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-bold text-ink">Our Mission</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              To give every organisation, regardless of size, access to specialised AI employees that handle
              repetitive, high-volume work reliably — so human teams can spend their time on decisions,
              relationships and growth.
            </p>
          </div>
          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <Eye className="h-7 w-7 text-saffron" aria-hidden="true" />
            <h2 className="mt-4 text-xl font-bold text-ink">Our Vision</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              A future where every department has an AI employee it can rely on — grounded in real organisational
              knowledge, connected to real tools, and accountable to the people it works alongside.
            </p>
          </div>
        </div>

        <div className="mt-8 rounded-card border border-royal/10 bg-ivory/60 p-6">
          <h2 className="text-xl font-bold text-ink">Why Krevia.ai Exists</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Most AI tools on the market are either narrow single-purpose chatbots or complex automation platforms
            that require significant engineering investment to configure. Neither gives a business team a
            dependable AI colleague they can hand real work to. Krevia.ai was built to close that gap — an
            operating layer that makes it possible to deploy an AI employee for a specific department in days,
            grounded in that department&apos;s real knowledge and tools, with governance built in from the start.
          </p>
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Responsible AI" title="Our Product Philosophy" />
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {principles.map((item) => (
              <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
            ))}
          </div>
        </div>
      </section>

      <section id="careers" className="mx-auto max-w-4xl scroll-mt-24 px-4 py-9 text-center sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Careers"
          title="Building the Team"
          description="We're growing the team behind Krevia.ai. We're not listing individual biographies here yet — reach out through our Contact page if you'd like to explore opportunities or partnerships."
        />
        <div className="mt-8">
          <ButtonLink href="/contact" variant="secondary">Get in Touch</ButtonLink>
        </div>
      </section>

      <section id="press" className="bg-white py-9 text-center">
        <div className="mx-auto max-w-3xl scroll-mt-24 px-4 sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow="Press and partners"
            title="Press Kit and Newsroom"
            description="Media and partnership resources are being prepared. For press or partnership enquiries, please contact our team directly."
          />
          <div className="mt-8">
            <ButtonLink href="/contact" variant="secondary">Contact Us</ButtonLink>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-9 text-center sm:px-6 lg:px-8">
        <SectionHeading title="Let's Build This Together" description="We work closely with every customer to shape AI employees around real workflows." />
        <div className="mt-8">
          <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
        </div>
      </section>
    </>
  );
}
