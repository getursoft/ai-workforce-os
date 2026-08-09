import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { departmentSolutions, orgTypeSolutions } from "@/content/solutions";

export const metadata: Metadata = defaultMetadata({
  title: "Solutions",
  description:
    "Explore Krevia.ai solutions by department and organisation type — from customer service and operations to enterprises and start-ups.",
  path: "/solutions",
});

const departmentRoutes: Record<string, string> = {
  "customer-service": "/solutions/customer-service",
  operations: "/solutions/operations",
  sales: "/solutions/sales",
  marketing: "/solutions/marketing",
  hr: "/solutions/hr",
  finance: "/solutions/finance",
  it: "/solutions/it",
  travel: "/solutions/travel",
};

const orgTypeRoutes: Record<string, string> = {
  startups: "/solutions/startups",
  enterprises: "/solutions/enterprise",
};

export default function SolutionsPage() {
  return (
    <>
      <PageHero
        eyebrow="Solutions"
        title="Solutions for Every Department and Organisation"
        description="Whichever team feels the most repetitive workload today, there's an AI employee configuration built for it."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="By department" title="Solutions by Department" />
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {departmentSolutions.map((solution) => {
            const href = departmentRoutes[solution.slug];
            const content = (
              <>
                <h3 className="text-lg font-semibold text-ink">{solution.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{solution.summary}</p>
                {href && (
                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-saffron">
                    Explore <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                )}
              </>
            );
            return href ? (
              <Link
                key={solution.slug}
                href={href}
                className="focus-ring group block rounded-card border border-royal/10 bg-white p-6 shadow-soft transition-all hover:-translate-y-1 hover:shadow-card"
              >
                {content}
              </Link>
            ) : (
              <div key={solution.slug} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
                {content}
              </div>
            );
          })}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="By organisation type" title="Solutions by Organisation Type" />
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {orgTypeSolutions.map((solution) => {
              const href = orgTypeRoutes[solution.slug];
              const content = (
                <>
                  <h3 className="text-lg font-semibold text-ink">{solution.name}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{solution.summary}</p>
                  {href && (
                    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-saffron">
                      Explore <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  )}
                </>
              );
              return href ? (
                <Link
                  key={solution.slug}
                  href={href}
                  className="focus-ring group block rounded-card border border-royal/10 bg-ivory/60 p-6 transition-all hover:-translate-y-1 hover:shadow-card"
                >
                  {content}
                </Link>
              ) : (
                <div key={solution.slug} className="rounded-card border border-royal/10 bg-ivory/60 p-6">
                  {content}
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
