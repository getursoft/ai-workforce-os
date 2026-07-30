import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Operations Solutions",
  description: "Keep processes moving with AI employees that track tasks, surface bottlenecks and coordinate handoffs.",
  path: "/solutions/operations",
});

export default function OperationsSolutionPage() {
  return <DepartmentSolutionTemplate slug="operations" />;
}
