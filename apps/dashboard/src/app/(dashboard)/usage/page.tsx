import type { Metadata } from "next";
import { BillingPage } from "../../../features/billing/billing-pages";

export const metadata: Metadata = { title: "Usage & Billing | AI Workforce OS" };

export default function Page() {
  return <BillingPage />;
}
