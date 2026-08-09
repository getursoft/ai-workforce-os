import type { Metadata } from "next";
import { BuyCreditsPage } from "../../../../features/billing/buy-credits-page";

export const metadata: Metadata = { title: "Buy Credits | Krevia.ai" };

export default function Page() {
  return <BuyCreditsPage />;
}
