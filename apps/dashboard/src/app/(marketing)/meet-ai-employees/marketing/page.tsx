import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Marketing AI Employee",
  description:
    "The Marketing AI Employee supports campaign planning, drafts content, researches audiences and summarises performance.",
  path: "/meet-ai-employees/marketing",
});

export default function MarketingAiEmployeePage() {
  return <EmployeeDetailTemplate slug="marketing" />;
}
