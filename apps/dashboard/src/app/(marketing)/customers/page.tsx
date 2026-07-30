import type { Metadata } from "next";
import { Plane, Users, Headset, Target, Wallet, Megaphone } from "lucide-react";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";

export const metadata: Metadata = defaultMetadata({
  title: "Customers and Use Cases",
  description:
    "Representative scenarios showing how organisations use AI employees across travel, HR, IT, sales, finance and marketing.",
  path: "/customers",
});

const scenarios = [
  {
    icon: Plane,
    title: "Travel Planning Company",
    context: "A travel company handling a high volume of custom itinerary requests from individual and corporate travellers.",
    approach: "A Travel AI Employee drafts itineraries and budget estimates, applies travel policy, and captures lead details before handing qualified enquiries to human travel consultants.",
    outcome: "Faster first response and more consistent itinerary quality across all enquiries.",
  },
  {
    icon: Users,
    title: "Enterprise HR Help Desk",
    context: "A large organisation with a shared-services HR team fielding thousands of policy and onboarding questions monthly.",
    approach: "An HR AI Employee answers routine policy and leave questions, guides onboarding, and escalates sensitive matters to human HR staff.",
    outcome: "Reduced repetitive query volume, freeing the HR team for higher-judgement work.",
  },
  {
    icon: Headset,
    title: "Internal IT Support",
    context: "A mid-sized company whose small IT team is overwhelmed by first-line technical requests.",
    approach: "An IT Support AI Employee resolves common issues, triages incidents by urgency, and escalates complex cases with full context attached.",
    outcome: "Faster first response times and better-prioritised escalations for engineers.",
  },
  {
    icon: Target,
    title: "Sales Qualification Team",
    context: "A B2B software company receiving more inbound leads than its sales development team can qualify quickly.",
    approach: "A Sales AI Employee qualifies leads against defined criteria, prepares meeting briefs, and hands qualified leads to the CRM with full context.",
    outcome: "Faster lead response times and reps arriving better prepared to every call.",
  },
  {
    icon: Wallet,
    title: "Finance Operations",
    context: "A finance team spending significant time on routine reporting and expense classification.",
    approach: "A Finance AI Employee generates summarised reports, classifies expenses, and explains budget variance, routing sensitive actions for approval.",
    outcome: "Faster turnaround on routine finance questions and more consistent expense classification.",
  },
  {
    icon: Megaphone,
    title: "Marketing Content Team",
    context: "A marketing team unable to keep pace with content demand across channels.",
    approach: "A Marketing AI Employee drafts first-pass content, researches audience segments, and summarises campaign performance for the team to refine.",
    outcome: "Faster first drafts and more consistent brand voice across channels.",
  },
];

export default function CustomersPage() {
  return (
    <>
      <PageHero
        eyebrow="Customers and use cases"
        title="How Organisations Put AI Employees to Work"
        description="These are representative scenarios based on common patterns we see across customer organisations — not endorsements from named customers."
      />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Representative scenarios" title="Illustrative Use Cases by Function" />
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {scenarios.map((scenario) => (
            <div key={scenario.title} className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-royal/5 text-royal">
                  <scenario.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-bold text-ink">{scenario.title}</h3>
              </div>
              <dl className="mt-4 space-y-3 text-sm leading-relaxed">
                <div>
                  <dt className="font-semibold text-muted">Context</dt>
                  <dd className="text-ink/80">{scenario.context}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-muted">Approach</dt>
                  <dd className="text-ink/80">{scenario.approach}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-muted">Outcome</dt>
                  <dd className="text-ink/80">{scenario.outcome}</dd>
                </div>
              </dl>
              <span className="mt-5 inline-block rounded-full bg-cream px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-saffron">
                Representative scenario
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading title="See What This Could Look Like for You" description="We'll walk through a scenario close to your organisation's real workflow." />
          <div className="mt-8">
            <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
