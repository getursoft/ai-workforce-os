import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Finance Solutions",
  description: "Speed up routine reporting and query handling while keeping approvals in human hands.",
  path: "/solutions/finance",
});

export default function FinanceSolutionPage() {
  return <DepartmentSolutionTemplate slug="finance" />;
}
