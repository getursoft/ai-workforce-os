import type { Metadata } from "next";
import { OrganizationsPage } from "../../../../features/admin/organizations-page";

export const metadata: Metadata = {
  title: "Organizations | AI Workforce OS",
  description: "Every organization on the platform"
};

export default function Page() {
  return <OrganizationsPage />;
}
