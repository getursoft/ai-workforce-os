import type { Metadata } from "next";
import { Plug, ShieldCheck, Eye, Workflow } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";
import { integrationCategories } from "@/content/integrations";

export const metadata: Metadata = defaultMetadata({
  title: "Platform Integrations",
  description:
    "How AI Workforce OS connects to the systems your organisation already uses, with scoped, permissioned and centrally visible integrations.",
  path: "/platform/integrations",
});

const principles = [
  { icon: Plug, title: "Pre-Built Connectors", description: "Common business systems connect through ready-made integrations." },
  { icon: Workflow, title: "Custom API Connectivity", description: "Internal or bespoke systems connect through a governed API layer." },
  { icon: ShieldCheck, title: "Scoped Data Access", description: "Each integration is permissioned to only what it needs." },
  { icon: Eye, title: "Central Visibility", description: "Administrators see every connected system in one place." },
];

export default function PlatformIntegrationsPage() {
  return (
    <>
      <PageHero
        eyebrow="Integrations"
        title="Connected to the Systems You Already Run On"
        description="AI employees are only as useful as the systems they can reach. Integrations connect them to your real data, safely and visibly."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="How it works" title="Integration Principles" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {principles.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Categories" title="Integration Categories at a Glance" />
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {integrationCategories.map((category) => (
              <div key={category.name} className="rounded-xl border border-royal/10 bg-ivory/60 px-4 py-5 text-center">
                <p className="text-sm font-semibold text-ink">{category.name}</p>
                <p className="mt-1 text-xs text-muted">{category.items.length} listed</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <ButtonLink href="/connect" variant="primary">View Full Integration Catalog</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
