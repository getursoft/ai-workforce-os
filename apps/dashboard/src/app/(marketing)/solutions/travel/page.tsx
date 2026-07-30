import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { DepartmentSolutionTemplate } from "@/components/solutions/department-solution-template";

export const metadata: Metadata = defaultMetadata({
  title: "Travel and Hospitality Solutions",
  description: "Help travellers plan faster and give your travel desk consistent, policy-aligned recommendations.",
  path: "/solutions/travel",
});

export default function TravelSolutionPage() {
  return <DepartmentSolutionTemplate slug="travel" />;
}
