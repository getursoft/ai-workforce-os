import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Finance AI Employee",
  description:
    "The Finance AI Employee helps with reports, invoices, expense classification and budget summaries, with human approval for sensitive actions.",
  path: "/meet-ai-employees/finance",
});

export default function FinanceAiEmployeePage() {
  return <EmployeeDetailTemplate slug="finance" />;
}
