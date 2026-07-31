import type { Metadata } from "next";
import { PaymentSettingsPage } from "../../../../../features/billing/payment-settings-page";

export const metadata: Metadata = { title: "Payment Settings | AI Workforce OS" };

export default function Page() {
  return <PaymentSettingsPage />;
}
