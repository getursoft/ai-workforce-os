import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Sales Solutions",
  description: "Qualify leads faster, prepare reps for every meeting, and keep pipeline data current.",
  path: "/solutions/sales",
});

export default function SalesSolutionPage() {
  return <DepartmentSolutionTemplate slug="sales" />;
}
