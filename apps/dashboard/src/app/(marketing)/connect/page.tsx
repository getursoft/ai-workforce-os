import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { StatusBadge } from "@/components/shared/status-badge";
import { ButtonLink } from "@/components/shared/button-link";
import { integrationCategories } from "@/content/integrations";

export const metadata: Metadata = defaultMetadata({
  title: "Integrations",
  description:
    "See how AI Workforce OS connects to CRM, email, calendar, documents, databases, cloud platforms, collaboration tools and more.",
  path: "/connect",
});

export default function IntegrationsPage() {
  return (
    <>
      <PageHero
        eyebrow="Integrations"
        title="Connect AI Employees to the Systems You Already Use"
        description="Every integration is scoped and permissioned. Status labels reflect where each connector actually stands today."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="space-y-10">
          {integrationCategories.map((category) => (
            <div key={category.name}>
              <div className="mb-4">
                <h2 className="text-xl font-bold text-ink">{category.name}</h2>
                <p className="text-sm text-muted">{category.description}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {category.items.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between rounded-xl border border-royal/10 bg-white px-5 py-4 shadow-soft"
                  >
                    <span className="text-sm font-medium text-ink">{item.name}</span>
                    <StatusBadge status={item.status} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-3xl border border-gold/30 bg-cream/60 p-8 text-center">
          <h2 className="text-2xl font-bold text-ink">Need something not listed here?</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Custom integrations connect AI employees to your internal or bespoke systems through a governed API
            layer. Tell us what you need and we&apos;ll help scope it.
          </p>
          <div className="mt-6">
            <ButtonLink href="/contact" variant="primary">Talk to Our Team</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
