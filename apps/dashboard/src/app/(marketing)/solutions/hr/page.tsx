import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "HR Solutions",
  description: "Free your HR team from repetitive queries so they can focus on people and culture.",
  path: "/solutions/hr",
});

export default function HrSolutionPage() {
  return <DepartmentSolutionTemplate slug="hr" />;
}
