import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Sales AI Employee",
  description:
    "The Sales AI Employee qualifies leads, preps reps for meetings, and keeps CRM data current between human conversations.",
  path: "/meet-ai-employees/sales",
});

export default function SalesAiEmployeePage() {
  return <EmployeeDetailTemplate slug="sales" />;
}
