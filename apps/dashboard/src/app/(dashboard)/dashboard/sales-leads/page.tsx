import type { Metadata } from "next";
import { SalesLeadsPage } from "../../../../features/admin/sales-leads/sales-leads-page";

export const metadata: Metadata = {
  title: "Sales Leads | Krevia.ai",
  description: "Leads generated for Krevia's own platform acquisition funnel"
};

export default function Page() {
  return <SalesLeadsPage />;
}
