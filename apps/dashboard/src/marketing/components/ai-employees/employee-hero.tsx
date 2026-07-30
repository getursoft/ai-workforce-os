import type { AiEmployee } from "@/content/ai-employees";
import { EmployeeIcon } from "./employee-icon";
import { Breadcrumb } from "@/components/shared/breadcrumb";
import { ButtonLink } from "@/components/shared/button-link";

export function EmployeeHero({ employee }: { employee: AiEmployee }) {
  return (
    <section className="relative overflow-hidden bg-royal pb-8">
      <div className="absolute inset-0 watermark-mandala opacity-[0.05]" aria-hidden="true" />
      <Breadcrumb items={[{ label: "AI Employees", href: "/meet-ai-employees" }, { label: employee.role }]} />
      <div className="relative mx-auto mt-6 flex max-w-4xl flex-col items-center px-6 text-center">
        <EmployeeIcon slug={employee.slug} iconColor={employee.iconColor} className="h-16 w-16 ring-4 ring-white/10" />
        <span className="mt-4 text-xs font-semibold uppercase tracking-[0.2em] text-gold">{employee.department}</span>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-white sm:text-5xl">{employee.role}</h1>
        <p className="mt-3 text-sm text-white/60">Meet {employee.name}</p>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-white/75 sm:text-lg">
          {employee.summary}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <ButtonLink href="/book-demo" variant="primary" className="bg-saffron hover:bg-[#d97b00]">
            Book a Demo
          </ButtonLink>
          <ButtonLink href="/meet-ai-employees" variant="secondary" className="border-white/30 bg-transparent text-white hover:bg-white/10">
            View All AI Employees
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
