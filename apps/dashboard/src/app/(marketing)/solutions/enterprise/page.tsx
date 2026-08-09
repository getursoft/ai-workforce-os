import type { Metadata } from "next";
import {
  Building2,
  KeyRound,
  ScrollText,
  ShieldCheck,
  ClipboardCheck,
  Lock,
  BookOpen,
  BarChart3,
  Boxes,
  Users2,
} from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Enterprise Solutions",
  description:
    "Deploy governed AI employees across business units with multi-tenant architecture, role-based access, auditability and configurable governance controls.",
  path: "/solutions/enterprise",
});

const pillars = [
  { icon: Building2, title: "Multi-Tenant Architecture", description: "Deploy across business units or subsidiaries with clear boundaries between them." },
  { icon: KeyRound, title: "Role-Based Access", description: "Configurable permissions define exactly who and what can act." },
  { icon: ClipboardCheck, title: "Governance Controls", description: "Configurable rules govern how AI employees behave across your organisation." },
  { icon: ScrollText, title: "Auditability", description: "A clear, reviewable record of AI employee actions and approvals." },
  { icon: ShieldCheck, title: "Security", description: "Designed to support enterprise security requirements at scale." },
  { icon: Lock, title: "Approval Controls", description: "Sensitive or high-impact actions are routed to designated reviewers." },
  { icon: Boxes, title: "Private Integrations", description: "Connect internal systems through a governed, permissioned API layer." },
  { icon: BookOpen, title: "Organisational Knowledge", description: "Ground AI employees in the specific documents and systems you choose." },
  { icon: BarChart3, title: "Usage Analytics", description: "Organisation-wide visibility into activity, adoption and outcomes." },
  { icon: Users2, title: "Support and Onboarding", description: "Dedicated onboarding support as you scope and deploy AI employees." },
];

export default function EnterpriseSolutionPage() {
  return (
    <>
      <PageHero
        eyebrow="For enterprises"
        title="Governed AI Employees at Enterprise Scale"
        description="Krevia.ai is designed to support enterprise security requirements with configurable governance controls and an integration-ready architecture — built for organisations deploying across multiple departments and business units."
      >
        <ButtonLink href="/contact" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
          Contact Sales
        </ButtonLink>
        <ButtonLink href="/security" variant="secondary">
          Read the Security Overview
        </ButtonLink>
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Built for scale" title="What Enterprise Deployment Includes" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {pillars.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow="A note on compliance"
            title="Honest About Where We Stand"
            description="Krevia.ai is designed to support enterprise security requirements, with configurable governance controls and an integration-ready architecture. We do not claim SOC 2, ISO 27001 or GDPR certification unless it has been formally confirmed — please contact our team for the current status of any certification your organisation requires."
          />
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-9 text-center sm:px-6 lg:px-8">
        <SectionHeading title="Ready to Discuss Enterprise Deployment?" />
        <div className="mt-8">
          <ButtonLink href="/contact" variant="primary">Contact Sales</ButtonLink>
        </div>
      </section>
    </>
  );
}
