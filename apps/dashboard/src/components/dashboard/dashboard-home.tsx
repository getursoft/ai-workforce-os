"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Line, LineChart, XAxis, YAxis, Legend, Tooltip, ResponsiveContainer } from "recharts";
import { MessagesSquare, Zap, Wallet, ShieldAlert, type LucideIcon } from "lucide-react";
import { useAuth, useCurrentUser } from "../../features/auth/auth-provider";
import { createAgentApi } from "../../features/agents/agent-api";
import { createBillingApi } from "../../features/billing/billing-api";
import { createApprovalApi } from "../../features/approvals/approval-api";
import { firstNameOrEmail } from "./dashboard-home.logic";
import { Badge, Card, PageHeader, Skeleton } from "../ui";

// A categorical palette where adjacent entries stay visually distinct even as thin 2px lines —
// avoids picking two reds/pinks next to each other, which read as the same color at a glance.
const EMPLOYEE_LINE_COLORS = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc949", "#af7aa1", "#9c755f"
];

/** Rolling window, not calendar-month start — a calendar-month default collapses to a single day
 *  whenever today is the 1st of the month, showing an empty dashboard right when the month rolls over. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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
  const employees = useQuery({ queryKey: ["dashboard", "employees"], queryFn: () => agentsApi.employees() });
  const summary = useQuery({
    queryKey: ["dashboard", "billing-summary"],
    queryFn: () => billingApi.summary(daysAgo(30), todayString())
  });
  const employeeTrend = useQuery({
    queryKey: ["dashboard", "billing-trend-by-employee"],
    queryFn: () => billingApi.trendByEmployee(daysAgo(30), todayString())
  });
  const approvals = useQuery({
    queryKey: ["dashboard", "approvals-pending", organization?.id],
    queryFn: () => approvalsApi.list(organization?.id ?? "", "PENDING"),
    enabled: Boolean(organization?.id)
  });

  const employeesInUse = (employees.data ?? []).filter((e) => e.status === "ACTIVE" && e.runtimeReady);
  const employeeRequestTrendData = employeeTrend.data?.requestPoints ?? [];
  const employeeTrendData = employeeTrend.data?.points ?? [];
  const employeeTokenTrendData = employeeTrend.data?.tokenPoints ?? [];
  const employeeTimeSavedData = employeeTrend.data?.timeSavedPoints ?? [];
  const employeeTrendSeries = employeeTrend.data?.employees ?? [];
  const assumedMinutesSaved = employeeTrend.data?.assumedMinutesSavedPerExecution ?? 8;
  const employeeColorOf = useMemo(() => {
    const colorByName = new Map(
      employeeTrendSeries.map((name, index) => [name, EMPLOYEE_LINE_COLORS[index % EMPLOYEE_LINE_COLORS.length] ?? "var(--primary)"])
    );
    return (name: string) => colorByName.get(name) ?? "var(--primary)";
  }, [employeeTrendSeries]);

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
          hint="Last 30 days"
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
          <EmployeeLineChart
            loading={employeeTrend.isLoading}
            series={employeeTrendSeries}
            data={employeeRequestTrendData}
            colorOf={employeeColorOf}
            emptyMessage="No AI activity has been recorded yet in the last 30 days."
          />
        </Card>

        <Card>
          <h2>Time Saved by AI Employee</h2>
          <p className="dashboard-home__muted">
            Estimated at {assumedMinutesSaved} minutes of manual work per completed request.
          </p>
          <EmployeeLineChart
            loading={employeeTrend.isLoading}
            series={employeeTrendSeries}
            data={employeeTimeSavedData}
            colorOf={employeeColorOf}
            unit="h"
            emptyMessage="No AI activity has been recorded yet in the last 30 days."
          />
        </Card>
      </section>

      <section className="dashboard-grid dashboard-grid--two">
        <Card>
          <h2>AI Employees in Use</h2>
          {employees.isLoading ? (
            <Skeleton className="dashboard-home__list-skeleton" />
          ) : (
            <>
              <p className="dashboard-stat-card__value">
                {employeesInUse.length.toLocaleString()}
                <span className="dashboard-home__muted"> / {(employees.data ?? []).length.toLocaleString()} installed</span>
              </p>
              {employeesInUse.length > 0 ? (
                <ul className="dashboard-activity-list">
                  {employeesInUse.map((employee) => (
                    <li key={employee.id} className="dashboard-activity-list__row">
                      <Badge tone="success">Active</Badge>
                      <span className="dashboard-activity-list__label">{employee.displayName}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dashboard-home__muted">No AI Employee is active and configured yet.</p>
              )}
            </>
          )}
        </Card>

        <Card>
          <h2>Credits by AI Employee</h2>
          <EmployeeLineChart
            loading={employeeTrend.isLoading}
            series={employeeTrendSeries}
            data={employeeTrendData}
            colorOf={employeeColorOf}
            emptyMessage="No credit usage has been recorded yet in the last 30 days."
          />

          <h2>Tokens by AI Employee</h2>
          <EmployeeLineChart
            loading={employeeTrend.isLoading}
            series={employeeTrendSeries}
            data={employeeTokenTrendData}
            colorOf={employeeColorOf}
            emptyMessage="No token usage has been recorded yet in the last 30 days."
          />
        </Card>
      </section>
    </div>
  );
}

function EmployeeLineChart({
  loading, series, data, colorOf, emptyMessage, unit
}: Readonly<{
  loading: boolean;
  series: string[];
  data: Array<Record<string, string | number>>;
  colorOf: (name: string) => string;
  emptyMessage: string;
  unit?: string;
}>) {
  if (loading) return <Skeleton className="dashboard-home__chart-skeleton" />;
  if (series.length === 0) return <p className="dashboard-home__muted">{emptyMessage}</p>;
  return (
    <div className="dashboard-home__chart">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} width={40} />
          <Tooltip
            formatter={(value, name) => [`${Number(value).toLocaleString()}${unit ? ` ${unit}` : ""}`, name]}
            contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }}
          />
          <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
          {series.map((name) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              name={name}
              stroke={colorOf(name)}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
