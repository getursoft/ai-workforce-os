import type { Metadata } from "next";
import { AiConfigurationPage } from "../../../../features/ai-configuration/ai-configuration-page";

export const metadata: Metadata = {
  title: "AI Providers | Krevia.ai"
};

export default function AiProvidersPageRoute() {
  return <AiConfigurationPage />;
}
