import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "IT Solutions",
  description: "Resolve common technical issues instantly and give engineers better-triaged escalations.",
  path: "/solutions/it",
});

export default function ItSolutionPage() {
  return <DepartmentSolutionTemplate slug="it" />;
}
