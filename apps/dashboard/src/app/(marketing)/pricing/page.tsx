import type { Metadata } from "next";
import { Check } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";
import { FaqAccordion } from "@/components/shared/faq-accordion";
import { pricingPlans, pricingComparison } from "@/content/pricing";
import { faqs } from "@/content/faqs";
import { cn } from "@/lib/utils";

export const metadata: Metadata = defaultMetadata({
  title: "Pricing",
  description:
    "Explore Starter, Growth and Enterprise plans for AI Workforce OS, scaled by the number of AI employees, integrations and governance features you need.",
  path: "/pricing",
});

export default function PricingPage() {
  const pricingFaqs = faqs.filter((f) => f.category === "Pricing");

  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Plans That Scale With Your AI Workforce"
        description="Every plan is built around the number of AI employees, integrations and governance features your organisation needs. Enterprise pricing is handled directly with our sales team."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-3">
          {pricingPlans.map((plan) => (
            <div
              key={plan.slug}
              className={cn(
                "flex flex-col rounded-card border p-6 shadow-soft",
                plan.highlighted ? "border-saffron bg-white ring-2 ring-saffron/30" : "border-royal/10 bg-white"
              )}
            >
              {plan.highlighted && (
                <span className="mb-3 inline-block w-fit rounded-full bg-saffron/15 px-3 py-1 text-xs font-semibold text-saffron">
                  Most Popular
                </span>
              )}
              <h2 className="text-xl font-bold text-ink">{plan.name}</h2>
              <p className="mt-2 text-2xl font-bold text-royal">{plan.price}</p>
              <p className="mt-1 text-xs text-muted">{plan.priceNote}</p>
              <p className="mt-4 text-sm leading-relaxed text-muted">{plan.description}</p>
              <ul className="mt-6 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm text-ink/80">
                    <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" aria-hidden="true" />
                    {feature}
                  </li>
                ))}
              </ul>
              <ButtonLink
                href={plan.cta.href}
                variant={plan.highlighted ? "primary" : "secondary"}
                className={cn("mt-8 w-full", plan.highlighted && "bg-saffron hover:bg-[#d97b00]")}
              >
                {plan.cta.label}
              </ButtonLink>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Compare plans" title="Feature Comparison" />
          <div className="mt-8 overflow-x-auto rounded-card border border-royal/10 shadow-soft">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="bg-cream/60 text-left">
                  <th className="px-6 py-4 font-semibold text-ink">Feature</th>
                  <th className="px-6 py-4 font-semibold text-ink">Starter</th>
                  <th className="px-6 py-4 font-semibold text-ink">Growth</th>
                  <th className="px-6 py-4 font-semibold text-ink">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {pricingComparison.map((row) => (
                  <tr key={row.feature} className="border-t border-royal/10">
                    <td className="px-6 py-4 font-medium text-ink">{row.feature}</td>
                    <td className="px-6 py-4 text-muted">{row.starter}</td>
                    <td className="px-6 py-4 text-muted">{row.growth}</td>
                    <td className="px-6 py-4 text-muted">{row.enterprise}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-7 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Questions" title="Pricing FAQs" size="secondary" />
        <div className="mt-8">
          <FaqAccordion items={pricingFaqs} />
        </div>
      </section>

      <section className="bg-white py-7">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading title="Still Deciding?" description="Book a demo and we'll help map the right plan to your organisation." size="secondary" />
          <div className="mt-8">
            <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
