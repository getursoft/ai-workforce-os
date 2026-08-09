import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { PageHero } from "@/components/shared/page-hero";
import { EmployeeCard } from "@/components/ai-employees/employee-card";
import { ButtonLink } from "@/components/shared/button-link";
import { aiEmployees } from "@/content/ai-employees";

export const metadata: Metadata = defaultMetadata({
  title: "AI Employees",
  description:
    "Meet the AI employees on Krevia.ai — Travel, HR, Finance, IT Support, Sales, Marketing and Custom roles built to work alongside your teams.",
  path: "/meet-ai-employees",
});

export default function AiEmployeesPage() {
  return (
    <>
      <PageHero
        eyebrow="AI Employees"
        title="Specialised AI Employees for Every Department"
        description="Each AI employee is grounded in your organisation's knowledge, connected to real tools, and built to hand off sensitive decisions to your human teams."
      />
      <section className="mx-auto max-w-7xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {aiEmployees.map((employee) => (
            <EmployeeCard key={employee.slug} employee={employee} />
          ))}
        </div>
        <div className="mt-8 rounded-3xl border border-gold/30 bg-cream/60 p-8 text-center">
          <h2 className="text-2xl font-bold text-ink">Not sure which AI employee fits your team?</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Tell us about your organisation and we&apos;ll help you find the right starting point — or scope a
            Custom AI Employee around your exact workflow.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-4">
            <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
            <ButtonLink href="/contact" variant="secondary">Talk to Our Team</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
