import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "../../../../components/ui";

export const metadata: Metadata = {
  title: "Sessions | AI Workforce OS"
};

export default function SessionsPage() {
  return (
    <div className="dashboard-placeholder">
      <PageHeader
        eyebrow="Account"
        title="Sessions"
        description="Session listing and revocation will appear when the backend exposes session APIs."
      />
      <EmptyState
        title="Session management is not supported yet"
        description="Sprint 1.1 keeps logout and refresh-token rotation secure, but it does not expose session inventory endpoints."
        action={<Link href="/dashboard/settings">Back to settings</Link>}
      />
    </div>
  );
}
