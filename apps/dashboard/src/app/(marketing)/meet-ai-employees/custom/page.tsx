import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Custom AI Employee",
  description:
    "Configure a Custom AI Employee scoped around your specific department, process, terminology and tools.",
  path: "/meet-ai-employees/custom",
});

export default function CustomAiEmployeePage() {
  return <EmployeeDetailTemplate slug="custom" />;
}
