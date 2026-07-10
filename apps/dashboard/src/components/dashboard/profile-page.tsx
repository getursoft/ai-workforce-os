"use client";

import { useCurrentUser } from "../../features/auth/auth-provider";
import { Card, PageHeader } from "../ui";

export function ProfilePage() {
  const { user, organization } = useCurrentUser();

  return (
    <div className="dashboard-placeholder">
      <PageHeader
        eyebrow="Account"
        title="Profile"
        description="Your authenticated identity from the backend."
      />
      <Card className="profile-card">
        <dl className="profile-grid">
          <div>
            <dt>Name</dt>
            <dd>{[user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Unknown"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user?.email ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Organization</dt>
            <dd>{organization?.name ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{user?.role ?? "Unknown"}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
