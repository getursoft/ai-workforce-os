import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Customer Support AI Employee",
  description:
    "The Customer Support AI Employee answers customer questions, troubleshoots issues and keeps tickets moving around the clock, escalating anything that needs a human touch.",
  path: "/meet-ai-employees/customer-support",
});

export default function CustomerSupportAiEmployeePage() {
  return <EmployeeDetailTemplate slug="customer-support" />;
}
