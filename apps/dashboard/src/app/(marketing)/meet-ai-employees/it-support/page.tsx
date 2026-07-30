import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "IT Support AI Employee",
  description:
    "The IT Support AI Employee handles first-line troubleshooting, ticketing and incident triage, escalating to human engineers when needed.",
  path: "/meet-ai-employees/it-support",
});

export default function ItSupportAiEmployeePage() {
  return <EmployeeDetailTemplate slug="it-support" />;
}
