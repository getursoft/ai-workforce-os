import type { Metadata } from "next";
import { BarChart3, TrendingUp, FileBarChart, Gauge } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { FeatureCard } from "@/components/shared/feature-card";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Analytics",
  description:
    "Visibility into what AI employees are doing across your organisation — usage, outcomes and trends by department.",
  path: "/platform/analytics",
});

const points = [
  { icon: BarChart3, title: "Usage Dashboards", description: "See conversation volume and activity by AI employee and department." },
  { icon: TrendingUp, title: "Trend Reporting", description: "Track how usage and outcomes change over time." },
  { icon: FileBarChart, title: "Exportable Summaries", description: "Share clear reporting with stakeholders and leadership." },
  { icon: Gauge, title: "Configurable Cadence", description: "Set the reporting rhythm that matches how your teams work." },
];

export default function AnalyticsPage() {
  return (
    <>
      <PageHero
        eyebrow="Analytics"
        title="See What Your AI Workforce Is Doing"
        description="Ongoing visibility into activity, outcomes and trends — so AI employees stay accountable, not opaque."
      />
      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Visibility" title="What You Can See" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {points.map((item) => (
            <FeatureCard key={item.title} icon={item.icon} title={item.title} description={item.description} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/book-demo" variant="primary">See Analytics in a Demo</ButtonLink>
        </div>
      </section>
    </>
  );
}
