"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from "recharts";
import { MessagesSquare, Zap, Wallet, ShieldAlert, type LucideIcon } from "lucide-react";
import { useAuth, useCurrentUser } from "../../features/auth/auth-provider";
import { createAgentApi } from "../../features/agents/agent-api";
import { createBillingApi } from "../../features/billing/billing-api";
import { createApprovalApi } from "../../features/approvals/approval-api";
import { firstNameOrEmail, relativeTime, toneForExecutionStatus } from "./dashboard-home.logic";
import { Badge, Card, PageHeader, Skeleton } from "../ui";

function monthStart(): string {
  const d = new Date();
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1).toISOString().slice(0, 10);
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

type StatTint = "stat-tint--blue" | "stat-tint--green" | "stat-tint--purple" | "stat-tint--amber";

function StatCard({
  icon: Icon, label, value, hint, tint, loading
}: Readonly<{ icon: LucideIcon; label: string; value: string; hint?: string; tint: StatTint; loading: boolean }>) {
  return (
    <Card className="dashboard-stat-card">
      <span className={`dashboard-stat-card__icon ${tint}`}>
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <p className="dashboard-stat-card__label">{label}</p>
      {loading ? <Skeleton className="dashboard-stat-card__skeleton" /> : <p className="dashboard-stat-card__value">{value}</p>}
      {hint ? <p className="dashboard-stat-card__hint">{hint}</p> : null}
    </Card>
  );
}

export function DashboardHome() {
  const { client } = useAuth();
  const { user, organization } = useCurrentUser();
  const greeting = firstNameOrEmail(user?.firstName ?? null, user?.email);

  const agentsApi = useMemo(() => createAgentApi(client), [client]);
  const billingApi = useMemo(() => createBillingApi(client), [client]);
  const approvalsApi = useMemo(() => createApprovalApi(client), [client]);

  const conversations = useQuery({ queryKey: ["dashboard", "conversations"], queryFn: () => agentsApi.conversations(1) });
  const executions = useQuery({ queryKey: ["dashboard", "executions"], queryFn: () => agentsApi.executions(1) });
  const summary = useQuery({
    queryKey: ["dashboard", "billing-summary"],
    queryFn: () => billingApi.summary(monthStart(), todayString())
  });
  const trend = useQuery({
    queryKey: ["dashboard", "billing-trend"],
    queryFn: () => billingApi.trend(monthStart(), todayString())
  });
  const approvals = useQuery({
    queryKey: ["dashboard", "approvals-pending", organization?.id],
    queryFn: () => approvalsApi.list(organization?.id ?? "", "PENDING"),
    enabled: Boolean(organization?.id)
  });

  const recentExecutions = (executions.data?.items ?? []).slice(0, 5);
  const chartData = (trend.data ?? []).map((p) => ({ date: p.date, requests: p.requests }));

  return (
    <div className="dashboard-home">
      <PageHeader
        eyebrow="Overview"
        title={`Welcome back, ${greeting}`}
        description={`Here's what's happening with ${organization?.name ?? "your organization"} today.`}
      />

      <section className="dashboard-grid dashboard-grid--summary" aria-label="Summary">
        <StatCard
          icon={MessagesSquare}
          label="Total Conversations"
          value={(conversations.data?.pagination.total ?? 0).toLocaleString()}
          tint="stat-tint--blue"
          loading={conversations.isLoading}
        />
        <StatCard
          icon={Zap}
          label="AI Executions"
          value={(executions.data?.pagination.total ?? 0).toLocaleString()}
          tint="stat-tint--green"
          loading={executions.isLoading}
        />
        <StatCard
          icon={Wallet}
          label="Credits Used"
          value={formatCompact(summary.data?.usedCredits ?? 0)}
          hint="This month"
          tint="stat-tint--purple"
          loading={summary.isLoading}
        />
        <StatCard
          icon={ShieldAlert}
          label="Pending Approvals"
          value={(approvals.data?.length ?? 0).toLocaleString()}
          tint="stat-tint--amber"
          loading={approvals.isLoading}
        />
      </section>

      <section className="dashboard-grid dashboard-grid--two">
        <Card>
          <h2>Requests over time</h2>
          {trend.isLoading ? (
            <Skeleton className="dashboard-home__chart-skeleton" />
          ) : chartData.length > 0 ? (
            <div className="dashboard-home__chart">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="dashboardActivityFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value) => [Number(value).toLocaleString(), "Requests"]} contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }} />
                  <Area type="monotone" dataKey="requests" stroke="var(--primary)" strokeWidth={2} fill="url(#dashboardActivityFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="dashboard-home__muted">No AI activity has been recorded yet this month.</p>
          )}
        </Card>

        <Card>
          <h2>Recent Activity</h2>
          {executions.isLoading ? (
            <Skeleton className="dashboard-home__list-skeleton" />
          ) : recentExecutions.length > 0 ? (
            <ul className="dashboard-activity-list">
              {recentExecutions.map((execution) => (
                <li key={execution.id} className="dashboard-activity-list__row">
                  <Badge tone={toneForExecutionStatus(execution.status)}>{execution.status}</Badge>
                  <span className="dashboard-activity-list__label">{execution.pluginInstallation.displayName}</span>
                  <span className="dashboard-activity-list__time">{relativeTime(execution.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dashboard-home__muted">No AI Employee activity yet — run one from AI Employees to see it here.</p>
          )}
        </Card>
      </section>

      <Card>
        <h2>Getting started</h2>
        <ol className="dashboard-list">
          <li>
            <Link href="/ai-employees">Create your first AI Employee</Link>
          </li>
          <li>
            <Link href="/dashboard/integrations">Connect a communication channel</Link>
          </li>
          <li>
            <Link href="/knowledge">Add a knowledge source</Link>
          </li>
          <li>
            <Link href="/ai-employees">Test your AI Employee</Link>
          </li>
        </ol>
      </Card>
    </div>
  );
}
