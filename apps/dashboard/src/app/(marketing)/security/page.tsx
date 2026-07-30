import type { Metadata } from "next";
import {
  KeyRound,
  Lock,
  ScrollText,
  ShieldCheck,
  Boxes,
  Trash2,
  Eye,
  ShieldAlert,
} from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Security",
  description:
    "How AI Workforce OS approaches access control, tenant isolation, encryption, audit logging, approvals and responsible AI safeguards.",
  path: "/security",
});

const points = [
  { icon: KeyRound, title: "Access Control", description: "Role-based permissions determine exactly who can configure, approve or view what across your organisation." },
  { icon: Lock, title: "Tenant Isolation", description: "Each organisation's data and configuration is scoped separately from every other organisation on the platform." },
  { icon: ShieldCheck, title: "Encryption Approach", description: "Data is encrypted in transit using industry-standard protocols, with encryption at rest for stored organisational content." },
  { icon: ScrollText, title: "Audit Logging", description: "AI employee actions, approvals and administrative changes are recorded for later review." },
  { icon: ShieldAlert, title: "Human Approval Controls", description: "Configurable thresholds route sensitive or high-impact actions to a designated human reviewer before they execute." },
  { icon: Boxes, title: "Secure Integrations", description: "Each integration is scoped to the minimum data access it needs, with credentials managed centrally." },
  { icon: Trash2, title: "Data Retention Controls", description: "Configurable retention settings let administrators control how long conversation and task data is kept." },
  { icon: Eye, title: "Administrative Visibility", description: "Administrators have central oversight into AI employee activity, integrations and access across the organisation." },
];

export default function SecurityPage() {
  return (
    <>
      <PageHero
        eyebrow="Security"
        title="Security and Governance, Built Into How the Platform Runs"
        description="AI Workforce OS is designed to support enterprise security requirements with configurable governance controls, so oversight travels with every AI employee rather than sitting alongside it."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Foundations" title="How We Approach Security" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
      </section>

      <section id="data-processing" className="scroll-mt-24 bg-white py-9">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Data processing" title="How Data Is Handled" />
          <div className="mt-8 space-y-4 text-sm leading-relaxed text-muted">
            <p>
              Organisational data connected to AI Workforce OS — including documents, policies and conversation
              history — is used only to power your organisation&apos;s own AI employees. It is not used to train
              shared models across customers.
            </p>
            <p>
              Data processing terms, including sub-processor information, are made available to customers as part
              of onboarding and can be requested at any time through our team.
            </p>
          </div>
        </div>
      </section>

      <section className="py-9">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow="Responsible AI"
            title="Safeguards We Build Around Every AI Employee"
            description="AI employees are grounded in confirmed organisational knowledge, defer to human approval on sensitive actions, and are designed to say when they don't have a confirmed answer rather than guess."
          />
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading
            eyebrow="A note on compliance"
            title="Honest About Where We Stand"
            description="AI Workforce OS is designed to support enterprise security requirements and uses an integration-ready architecture with configurable governance controls. We do not display SOC 2, ISO 27001 or GDPR certification badges unless those certifications have been formally confirmed — contact our team for the current status of any certification your organisation requires."
          />
        </div>
      </section>

      <section id="status" className="scroll-mt-24 py-9">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading eyebrow="System status" title="Platform Status" />
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-success/30 bg-success/5 px-5 py-2.5 text-sm font-semibold text-success">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
            All systems operational
          </div>
          <p className="mt-4 text-sm text-muted">A live status page is provided to customers as part of onboarding.</p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-9 text-center sm:px-6 lg:px-8">
        <SectionHeading title="Have a Security Question?" description="Our team can walk through your organisation's specific requirements." />
        <div className="mt-8">
          <ButtonLink href="/contact" variant="primary">Contact Us</ButtonLink>
        </div>
      </section>
    </>
  );
}
