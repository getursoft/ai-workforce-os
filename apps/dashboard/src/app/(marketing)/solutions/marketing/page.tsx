import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Marketing Solutions",
  description: "Move faster from brief to campaign with an AI employee that drafts content and reports on results.",
  path: "/solutions/marketing",
});

export default function MarketingSolutionPage() {
  return <DepartmentSolutionTemplate slug="marketing" />;
}
