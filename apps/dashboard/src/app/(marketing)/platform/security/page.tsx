import type { Metadata } from "next";
import { KeyRound, Lock, ScrollText, ShieldCheck } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Platform Security",
  description:
    "How Krevia.ai approaches access control, tenant isolation, audit logging and human approval as part of the operating layer.",
  path: "/platform/security",
});

const points = [
  { icon: KeyRound, title: "Role-Based Access", description: "Configurable permissions control who and what can act." },
  { icon: Lock, title: "Tenant Isolation", description: "Organisational data stays scoped to your organisation." },
  { icon: ScrollText, title: "Audit Logging", description: "A durable record of AI employee actions and approvals." },
  { icon: ShieldCheck, title: "Approval Controls", description: "Sensitive actions route to a human before execution." },
];

export default function PlatformSecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="Governance Built into the Operating Layer"
        description="Security isn't an add-on — access control, isolation, logging and approvals are part of how the platform runs every AI employee."
      />
      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Foundations" title="What's Built In" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/security" variant="primary">Read the Full Security Overview</ButtonLink>
        </div>
      </section>
    </>
  );
}
