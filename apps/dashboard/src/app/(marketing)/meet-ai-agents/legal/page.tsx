import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Legal Document AI Agent",
  description:
    "The Legal Document AI Agent reads incoming legal and regulatory notifications for CA firms and advocates, and drafts structured replies ready for professional review.",
  path: "/meet-ai-agents/legal",
});

export default function LegalAiEmployeePage() {
  return <EmployeeDetailTemplate slug="legal" />;
}
