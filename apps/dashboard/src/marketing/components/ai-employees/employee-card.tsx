import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { AiEmployee } from "@/content/ai-employees";
import { EmployeeIcon } from "./employee-icon";

export function EmployeeCard({ employee }: { employee: AiEmployee }) {
  return (
    <div className="group flex h-full flex-col rounded-card border border-[#E9EDF5] bg-white p-4 shadow-md transition-all duration-[220ms] ease-out hover:-translate-y-1.5 hover:border-royal/50 hover:shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <EmployeeIcon
          slug={employee.slug}
          iconColor={employee.iconColor}
          className="h-[52px] w-[52px] rounded-xl transition-transform duration-[220ms] group-hover:scale-105"
          iconClassName="h-7 w-7"
        />
        <span className="shrink-0 rounded-full border border-[#E9EDF5] bg-[#F6F8FC] px-2 py-1 text-center text-[9px] font-semibold uppercase leading-snug text-muted">
          {employee.badge}
        </span>
      </div>

      <h3 className="mt-2.5 text-[22px] font-bold leading-tight text-royal">{employee.role}</h3>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {employee.department}
      </p>
      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">{employee.summary}</p>

      <div className="mt-2.5 rounded-[10px] bg-cream/70 p-[10px]">
        <p className="text-[9px] font-semibold uppercase tracking-wide text-saffron">Example</p>
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-ink/80">
          &ldquo;{employee.exampleRequests[0]}&rdquo;
        </p>
      </div>

      <Link
        href={`/meet-ai-employees/${employee.slug}`}
        className="focus-ring group/link mt-auto inline-flex items-center gap-1.5 pt-2.5 text-sm font-semibold text-saffron hover:underline"
      >
        View Details
        <ArrowRight
          className="h-3.5 w-3.5 transition-transform duration-200 group-hover/link:translate-x-1"
          aria-hidden="true"
        />
      </Link>
    </div>
  );
}
