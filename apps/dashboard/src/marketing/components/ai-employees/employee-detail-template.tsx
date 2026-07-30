import { getAiEmployee } from "@/content/ai-employees";
import { EmployeeHero } from "./employee-hero";
import { CapabilityList } from "./capability-list";
import { ExampleRequests } from "./example-requests";
import { DepartmentUseCases } from "./department-use-cases";
import { SectionHeading } from "@/components/shared/section-heading";
import { ButtonLink } from "@/components/shared/button-link";
import { aiEmployees } from "@/content/ai-employees";

export function EmployeeDetailTemplate({ slug }: { slug: string }) {
  const employee = getAiEmployee(slug);
  if (!employee) return null;

  const others = aiEmployees.filter((e) => e.slug !== slug).slice(0, 3);

  return (
    <>
      <EmployeeHero employee={employee} />

      <section className="mx-auto max-w-6xl px-4 py-9 sm:px-6 lg:px-8">
        <CapabilityList title={`What the ${employee.role} Does`} items={employee.capabilities} />
      </section>

      <section className="bg-white py-9">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <DepartmentUseCases
            responsibilities={employee.responsibilities}
            outcomes={employee.outcomes}
            handoffNote={employee.handoffNote}
          />
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-9 sm:px-6 lg:px-8">
        <ExampleRequests requests={employee.exampleRequests} />
      </section>

      <section className="bg-white py-7">
        <div className="mx-auto max-w-6xl px-4 text-center sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Explore more" title="Other AI Employees" size="secondary" />
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {others.map((other) => (
              <ButtonLink key={other.slug} href={`/meet-ai-employees/${other.slug}`} variant="secondary">
                {other.role}
              </ButtonLink>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-7 text-center sm:px-6 lg:px-8">
        <SectionHeading title={`See the ${employee.role} in Action`} description="Book a guided demo built around your organisation's real workflows." size="secondary" />
        <div className="mt-8">
          <ButtonLink href="/book-demo" variant="primary">Book a Demo</ButtonLink>
        </div>
      </section>
    </>
  );
}
