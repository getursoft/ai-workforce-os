import type { Metadata } from "next";
import { Rocket, Gauge, Wallet, Users } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";
import { orgTypeSolutions } from "@/content/solutions";

export const metadata: Metadata = defaultMetadata({
  title: "Start-up Solutions",
  description:
    "Get enterprise-grade support functions running from day one, without hiring a full team for every role.",
  path: "/solutions/startups",
});

const points = [
  { icon: Rocket, title: "Fast to Deploy", description: "Get an AI employee live for support, sales or operations in days." },
  { icon: Gauge, title: "Scales With You", description: "Add coverage as customer and employee volume grows, without a hiring cycle for every increase." },
  { icon: Wallet, title: "Predictable Cost", description: "Extend team capacity without proportional headcount growth." },
  { icon: Users, title: "Focus Where It Matters", description: "Free your small team to focus on product and customers, not repetitive admin." },
];

export default function StartupsSolutionPage() {
  const solution = orgTypeSolutions.find((s) => s.slug === "startups");
  if (!solution) throw new Error("Missing 'startups' entry in orgTypeSolutions content.");

  return (
    <>
      <PageHero eyebrow="For start-ups" title="Enterprise-Grade Support Without Enterprise Headcount" description={solution.summary}>
        <ButtonLink href="/book-demo" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
          Book a Demo
        </ButtonLink>
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Why start-ups choose Krevia.ai" title="Built for Lean Teams" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading title="Start Small, Scale as You Grow" description="Begin with a single AI employee and expand coverage as your organisation grows." />
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <ButtonLink href="/pricing" variant="primary">See Pricing</ButtonLink>
            <ButtonLink href="/meet-ai-employees" variant="secondary">Explore AI Employees</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
