import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Customer Service Solutions",
  description: "Give customers instant, accurate answers around the clock while your support team focuses on complex cases.",
  path: "/solutions/customer-service",
});

export default function CustomerServiceSolutionPage() {
  return <DepartmentSolutionTemplate slug="customer-service" />;
}
