import type { Metadata } from "next";
import { defaultMetadata } from "@/lib/seo";
import { EmployeeDetailTemplate } from "@/components/ai-employees/employee-detail-template";

export const metadata: Metadata = defaultMetadata({
  title: "Travel AI Agent",
  description:
    "The Travel AI Agent plans trips, builds itineraries, estimates budgets and supports travellers — with booking hand-off to your connected systems.",
  path: "/meet-ai-agents/travel",
});

export default function TravelAiEmployeePage() {
  return <EmployeeDetailTemplate slug="travel" />;
}
