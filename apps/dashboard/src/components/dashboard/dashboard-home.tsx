"use client";

import Link from "next/link";
import { useCurrentUser } from "../../features/auth/auth-provider";
import { firstNameOrEmail } from "./dashboard-home.logic";
import { Badge, Card, EmptyState, PageHeader, SummaryCard } from "../ui";

export function DashboardHome() {
  const { user, organization } = useCurrentUser();
  const greeting = firstNameOrEmail(user?.firstName ?? null, user?.email);

  return (
    <div className="dashboard-home">
      <PageHeader
        eyebrow="Overview"
        title={`Welcome back, ${greeting}`}
        description={`You are signed in to ${organization?.name ?? "your organization"}.`}
      />

      <section className="dashboard-grid dashboard-grid--summary" aria-label="Summary cards">
        <SummaryCard title="AI Employees" value={0} hint="No employees created yet." />
        <SummaryCard title="Active Tasks" value={0} hint="Tasks will appear here later." />
        <SummaryCard title="Conversations" value={0} hint="No recent conversations." />
        <SummaryCard title="Pending Actions" value={0} hint="Nothing needs attention right now." />
      </section>

      <section className="dashboard-grid dashboard-grid--two">
        <Card>
          <h2>Getting started</h2>
          <ol className="dashboard-list">
            <li>
              <Link href="/dashboard/ai-employees">Create your first AI Employee</Link>
            </li>
            <li>
              <Link href="/dashboard/integrations">Connect a communication channel</Link>
            </li>
            <li>
              <Link href="/dashboard/knowledge">Add a knowledge source</Link>
            </li>
            <li>
              <Link href="/dashboard/ai-employees">Test your AI Employee</Link>
            </li>
          </ol>
        </Card>

        <Card>
          <h2>Platform status</h2>
          <div className="dashboard-status">
            <div>
              <p>API connectivity</p>
              <Badge tone="success">Connected</Badge>
            </div>
            <div>
              <p>Authentication status</p>
              <Badge tone="success">{user ? "Authenticated" : "Unknown"}</Badge>
            </div>
            <div>
              <p>Organization status</p>
              <Badge tone={organization?.status === "ACTIVE" ? "success" : "warning"}>
                {organization?.status ?? "Unknown"}
              </Badge>
            </div>
          </div>
        </Card>
      </section>

      <Card>
        <h2>Next milestones</h2>
        <EmptyState
          title="Sprint 2 will add operational workflows"
          description="The current sprint only establishes identity, navigation, and the dashboard shell."
        />
      </Card>
    </div>
  );
}
