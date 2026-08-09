import type { Metadata } from "next";
import { BillingPage } from "../../../features/billing/billing-pages";

export const metadata: Metadata = { title: "Usage & Billing | Krevia.ai" };

export default function Page() {
  return <BillingPage />;
}
