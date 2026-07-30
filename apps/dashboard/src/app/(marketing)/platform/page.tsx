import type { Metadata } from "next";
import {
  MessageSquare,
  Mail,
  Globe,
  Users,
  BookOpen,
  BrainCircuit,
  Wrench,
  ListChecks,
  ShieldCheck,
  BarChart3,
  Plug,
  Users2,
} from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ArchitectureLayers } from "@/components/shared/architecture-layers";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Platform Overview",
  description:
    "AI Workforce OS is the operating layer for AI employees — managing knowledge, memory, tools, approvals, analytics, security and collaboration in one place.",
  path: "/platform",
});

const layers = [
  {
    title: "Communication Channels",
    description: "Where people and AI employees meet — on the web, internally, or by email.",
    items: [
      { icon: Globe, label: "Web Chat" },
      { icon: MessageSquare, label: "Internal Channels" },
      { icon: Mail, label: "Email" },
    ],
  },
  {
    title: "AI Employees",
    description: "Role-based AI workers configured for a department, with defined scope and tone.",
    items: [
      { icon: Users, label: "Travel · HR · Finance" },
      { icon: Users, label: "IT · Sales · Marketing" },
      { icon: Users2, label: "Custom Roles" },
    ],
  },
  {
    title: "Operating Layer",
    description: "The shared core every AI employee runs on — knowledge, memory, tools, tasks and approvals.",
    items: [
      { icon: BookOpen, label: "Organisational Knowledge" },
      { icon: BrainCircuit, label: "Memory & Preferences" },
      { icon: Wrench, label: "Tool Access" },
      { icon: ListChecks, label: "Task Execution" },
      { icon: ShieldCheck, label: "Human Approvals" },
    ],
  },
  {
    title: "Governance & Insight",
    description: "Oversight that runs underneath every interaction, not bolted on afterwards.",
    items: [
      { icon: BarChart3, label: "Analytics" },
      { icon: ShieldCheck, label: "Security" },
      { icon: Plug, label: "Integrations" },
    ],
  },
];

const pillars = [
  { icon: Users, title: "AI Employee Management", description: "Configure, scope and monitor every AI employee from one place." },
  { icon: BookOpen, title: "Organisational Knowledge", description: "Ground responses in your documents, policies and systems." },
  { icon: BrainCircuit, title: "Memory and Preferences", description: "Retain relevant context across conversations and time." },
  { icon: Wrench, title: "Tool Access", description: "Connect approved tools so AI employees can act, not just answer." },
  { icon: ListChecks, title: "Task Execution", description: "Plan, track and complete multi-step work reliably." },
  { icon: ShieldCheck, title: "Human Approvals", description: "Route sensitive actions to the right person before they run." },
  { icon: BarChart3, title: "Analytics", description: "See usage, outcomes and trends across every department." },
  { icon: Users2, title: "Multi-Agent Collaboration", description: "AI employees coordinate with each other and with your teams." },
];

export default function PlatformPage() {
  return (
    <>
      <PageHero
        eyebrow="Platform"
        title="One Operating Layer for Every AI Employee"
        description="AI Workforce OS is the operating system that AI employees run on — connecting knowledge, memory, tools, approvals, analytics and security into a single governed layer."
      >
        <ButtonLink href="/book-demo" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
          Book a Demo
        </ButtonLink>
        <ButtonLink href="/platform/capabilities" variant="secondary">
          See Capabilities
        </ButtonLink>
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="How it fits together"
          title="From Conversation to Governed Action"
          description="A simplified view of how a request flows through the platform — without exposing internal implementation detail."
        />
        <div className="mt-8">
          <ArchitectureLayers layers={layers} />
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Core pillars" title="What the Operating Layer Provides" />
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {pillars.map((item) => (
              <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-7 text-center sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="Explore further"
          title="Go Deeper on Each Part of the Platform"
          description="Capabilities, knowledge and memory, integrations, security and analytics each have a dedicated page."
          size="secondary"
        />
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/platform/capabilities" variant="secondary">Capabilities</ButtonLink>
          <ButtonLink href="/platform/knowledge" variant="secondary">Knowledge & Memory</ButtonLink>
          <ButtonLink href="/platform/integrations" variant="secondary">Integrations</ButtonLink>
          <ButtonLink href="/platform/security" variant="secondary">Security</ButtonLink>
          <ButtonLink href="/platform/analytics" variant="secondary">Analytics</ButtonLink>
        </div>
      </section>
    </>
  );
}
