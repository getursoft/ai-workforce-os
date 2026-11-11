import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "HR AI Agent",
  description:
    "The HR AI Agent answers agent questions, supports onboarding and leave, and escalates sensitive matters to your human HR team.",
  path: "/meet-ai-agents/hr",
});

export default function HrAiEmployeePage() {
  return <EmployeeDetailTemplate slug="hr" />;
}
