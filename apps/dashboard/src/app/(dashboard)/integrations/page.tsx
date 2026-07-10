import type { Metadata } from "next";
import { PlaceholderPage } from "../../../components/dashboard/placeholder-page";

export const metadata: Metadata = {
  title: "Integrations | AI Workforce OS"
};

export default function IntegrationsPage() {
  return (
    <PlaceholderPage
      title="Integrations"
      description="Connect communication channels in a later sprint."
    />
  );
}
