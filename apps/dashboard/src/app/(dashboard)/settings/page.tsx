import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "../../../components/ui";

export const metadata: Metadata = {
  title: "Settings | AI Workforce OS"
};

export default function SettingsPage() {
  return (
    <div className="dashboard-placeholder">
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Account, organization, and session settings live here."
      />
      <EmptyState
        title="Session management is not available yet"
        description="The backend for listing and revoking individual sessions has not been exposed in Sprint 1.1."
        action={<Link href="/dashboard/profile">Open profile</Link>}
      />
    </div>
  );
}
