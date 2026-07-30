import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { departmentSolutions, type DepartmentSolution } from "@/content/solutions";
import { aiEmployees } from "@/content/ai-employees";
import { PageHero } from "@/components/shared/page-hero";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";

export function getDepartmentSolution(slug: string): DepartmentSolution | undefined {
  return departmentSolutions.find((d) => d.slug === slug);
}

export function DepartmentSolutionTemplate({ slug }: { slug: string }) {
  const solution = getDepartmentSolution(slug);
  if (!solution) return null;

  const related = aiEmployees.filter((e) => solution.relatedEmployees.includes(e.slug));

  return (
    <>
      <PageHero
        eyebrow="Solutions"
        title={`AI Employees for ${solution.name}`}
        description={solution.summary}
      >
        <ButtonLink href="/book-demo" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
          Book a Demo
        </ButtonLink>
      </PageHero>

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <div className="mb-4 flex items-center gap-2 text-muted">
              <AlertTriangle className="h-5 w-5 text-saffron" aria-hidden="true" />
              <h2 className="text-lg font-bold text-ink">Common Challenges</h2>
            </div>
            <ul className="space-y-3 text-sm leading-relaxed text-muted">
              {solution.challenges.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted/50" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-card border border-royal/10 bg-white p-6 shadow-soft">
            <div className="mb-4 flex items-center gap-2 text-royal">
              <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
              <h2 className="text-lg font-bold text-ink">How AI Employees Help</h2>
            </div>
            <ul className="space-y-3 text-sm leading-relaxed text-ink/80">
              {solution.howAiEmployeesHelp.map((item) => (
                <li key={item} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {related.length > 0 && (
        <section className="bg-white py-7">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <SectionHeading eyebrow="Relevant AI employees" title="Where to Start" size="secondary" />
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              {related.map((employee) => (
                <ButtonLink key={employee.slug} href={`/meet-ai-employees/${employee.slug}`} variant="secondary">
                  {employee.role}
                </ButtonLink>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="mx-auto max-w-3xl px-4 py-7 text-center sm:px-6 lg:px-8">
        <SectionHeading title={`See ${solution.name} AI Employees in Action`} size="secondary" />
        <div className="mt-8">
          <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
        </div>
      </section>
    </>
  );
}
