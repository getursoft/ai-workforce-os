import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Marketing AI Agent",
  description:
    "The Marketing AI Agent supports campaign planning, drafts content, researches audiences and summarises performance.",
  path: "/meet-ai-agents/marketing",
});

export default function MarketingAiEmployeePage() {
  return <EmployeeDetailTemplate slug="marketing" />;
}
