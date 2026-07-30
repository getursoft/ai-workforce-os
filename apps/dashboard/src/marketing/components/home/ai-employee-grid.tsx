import { SectionHeading } from "@/components/shared/section-heading";
import { EmployeeCard } from "@/components/ai-employees/employee-card";
import { ButtonLink } from "@/components/shared/button-link";
import { aiEmployees } from "@/content/ai-employees";

export function AiEmployeeGrid() {
  const featured = aiEmployees.filter((employee) => employee.slug !== "custom");

  return (
    <section className="bg-white px-4 py-9 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          eyebrow="Meet the team"
          title="AI Employees for Every Department"
          description="Specialised AI employees that handle real work across your organisation."
        />
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4 [@media(min-width:1440px)]:grid-cols-6">
          {featured.map((employee) => (
            <EmployeeCard key={employee.slug} employee={employee} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/meet-ai-employees" variant="secondary">
            View All AI Employees
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
