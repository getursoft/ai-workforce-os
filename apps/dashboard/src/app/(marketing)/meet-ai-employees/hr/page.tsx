import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "HR AI Employee",
  description:
    "The HR AI Employee answers employee questions, supports onboarding and leave, and escalates sensitive matters to your human HR team.",
  path: "/meet-ai-employees/hr",
});

export default function HrAiEmployeePage() {
  return <EmployeeDetailTemplate slug="hr" />;
}
