import type { Metadata } from "next";
import { OrganizationPage } from "../../../../features/organization/pages/organization-page";

export const metadata: Metadata = { title: "Organization | Krevia.ai" };

export default function Page() {
  return <OrganizationPage />;
}
