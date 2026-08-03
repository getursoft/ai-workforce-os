"use client";

import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine
} from "recharts";
import Link from "next/link";
import { RefreshCw, Download, Zap } from "lucide-react";
import { useAuth } from "../auth/auth-provider";
import {
  createBillingApi,
  type CapabilityUsage,
  type EmployeeUsage,
  type ModelUsage,
  type TrendPoint,
  type UsageSummary,
  type UserUsage
} from "./billing-api";
import { AccessGate } from "../admin/authorization";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from "../../components/ui";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createBillingApi(client), [client]);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatCredits(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function average(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rolling window, not calendar-month start — a calendar-month default collapses to a single day
 *  whenever today is the 1st of the month, showing an empty page right when the month rolls over. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function downloadTrendCsv(trend: readonly TrendPoint[]): void {
  const header = "date,creditsConsumed,inputTokens,outputTokens,totalTokens,requests";
  const rows = trend.map((p) => [p.date, p.creditsConsumed, p.inputTokens, p.outputTokens, p.totalTokens, p.requests].join(","));
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `usage-${todayString()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function ThresholdBadge({ threshold }: Readonly<{ threshold: UsageSummary["threshold"] }>) {
  const tones: Record<string, "success" | "warning" | "danger" | "neutral"> = {
    NORMAL: "success", INFORMATIONAL: "warning", WARNING: "danger", LIMIT_REACHED: "danger", OVERAGE: "danger"
  };
  const labels: Record<string, string> = {
    NORMAL: "Normal", INFORMATIONAL: "Caution", WARNING: "High usage", LIMIT_REACHED: "Limit reached", OVERAGE: "Overage active"
  };
  return <Badge tone={tones[threshold] ?? "neutral"}>{labels[threshold] ?? threshold}</Badge>;
}

function UsageToolbar({
  start, end, onChange, onRefresh, onExport, isFetching
}: Readonly<{
  start: string; end: string;
  onChange(s: string, e: string): void;
  onRefresh(): void;
  onExport(): void;
  isFetching: boolean;
}>) {
  return (
    <div className="usage-v2__toolbar">
      <div className="usage-v2__date-range">
        <input
          type="date"
          className="ui-input usage-v2__date-input"
          value={start}
          max={end}
          aria-label="Start date"
          onChange={(e) => onChange(e.target.value, end)}
        />
        <span className="usage-v2__date-sep">–</span>
        <input
          type="date"
          className="ui-input usage-v2__date-input"
          value={end}
          min={start}
          max={todayString()}
          aria-label="End date"
          onChange={(e) => onChange(start, e.target.value)}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        className="usage-v2__icon-button"
        onClick={onRefresh}
        aria-label="Refresh usage data"
        title="Refresh"
      >
        <RefreshCw size={15} className={isFetching ? "usage-v2__spin" : ""} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="usage-v2__icon-button"
        onClick={onExport}
        aria-label="Export usage data as CSV"
        title="Export CSV"
      >
        <Download size={15} />
      </Button>
    </div>
  );
}

function HeadlineSpendCard({
  summary, trend
}: Readonly<{ summary: UsageSummary; trend: readonly TrendPoint[] }>) {
  const avgCredits = useMemo(() => average(trend.map((p) => p.creditsConsumed)), [trend]);
  const chartData = trend.map((p) => ({ ...p, label: formatShortDate(p.date) }));
  return (
    <Card className="usage-v2-card usage-v2__headline">
      <div className="usage-v2__headline-top">
        <div>
          <p className="usage-v2__eyebrow">Total spend</p>
          <p className="usage-v2__headline-number">{formatCredits(summary.usedCredits)}<span> credits</span></p>
          {avgCredits > 0 ? <p className="usage-v2__headline-hint">avg {formatCredits(avgCredits)} / day</p> : null}
        </div>
        <ThresholdBadge threshold={summary.threshold} />
      </div>
      {chartData.length > 0 ? (
        <div className="usage-v2__chart">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} tickMargin={8} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} tickMargin={8} axisLine={false} tickLine={false} width={44} />
              <Tooltip
                formatter={(value) => [formatCredits(Number(value)), "Credits"]}
                labelFormatter={(label) => `${label}`}
                contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }}
              />
              {avgCredits > 0 ? (
                <ReferenceLine y={avgCredits} stroke="#6366f1" strokeDasharray="4 4" strokeWidth={1.5} />
              ) : null}
              <Bar dataKey="creditsConsumed" name="Credits" fill="#6366f1" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState title="No usage yet" description="No AI activity has been recorded for this period." />
      )}
    </Card>
  );
}

type MainTabId = "models" | "capabilities" | "employees";
const MAIN_TABS: readonly { id: MainTabId; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "capabilities", label: "Spend categories" },
  { id: "employees", label: "AI Employees" }
];

function ModelsPanel({ data }: Readonly<{ data: readonly ModelUsage[] }>) {
  if (!data.length) return <p className="usage-v2__muted">No model usage recorded for this period.</p>;
  const chartData = data.map((m) => ({ name: `${m.model}`, tokens: m.totalTokens }));
  return (
    <div className="usage-v2__panel-split">
      <div className="usage-v2__mini-chart">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 12 }}>
            <XAxis type="number" tick={{ fontSize: 10, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "var(--muted)" }} width={90} axisLine={false} tickLine={false} />
            <Tooltip formatter={(value) => [formatCompact(Number(value)), "Tokens"]} contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }} />
            <Bar dataKey="tokens" fill="#6366f1" radius={[0, 4, 4, 0]} maxBarSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="usage-v2__table">
        <thead><tr><th>Model</th><th>Requests-equiv tokens</th><th>Credits</th></tr></thead>
        <tbody>
          {data.map((m, i) => (
            <tr key={`${m.provider}-${m.model}-${i}`}>
              <td>
                <span className="usage-v2__table-primary">{m.model}</span>
                <span className="usage-v2__table-secondary">{m.provider}</span>
              </td>
              <td>{formatCompact(m.totalTokens)}</td>
              <td>{formatCredits(m.creditsConsumed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CapabilitiesPanel({ data }: Readonly<{ data: readonly CapabilityUsage[] }>) {
  if (!data.length) return <p className="usage-v2__muted">No capability usage recorded for this period.</p>;
  return (
    <ul className="usage-v2__bars">
      {data.map((c) => (
        <li key={c.capability} className="usage-v2__bar-row">
          <span className="usage-v2__bar-label">{c.displayName}</span>
          <span className="usage-v2__bar-track">
            <span className="usage-v2__bar-fill" style={{ width: `${Math.min(c.sharePercentage, 100)}%` }} />
          </span>
          <span className="usage-v2__bar-value">{c.sharePercentage}%</span>
        </li>
      ))}
    </ul>
  );
}

function EmployeesPanel({ data }: Readonly<{ data: readonly EmployeeUsage[] }>) {
  if (!data.length) return <p className="usage-v2__muted">No AI employee usage recorded for this period.</p>;
  return (
    <table className="usage-v2__table">
      <thead><tr><th>Employee</th><th>Executions</th><th>Tokens</th><th>Credits</th></tr></thead>
      <tbody>
        {data.map((e) => (
          <tr key={e.pluginInstallationId}>
            <td className="usage-v2__table-primary">{e.employeeName}</td>
            <td>{e.executions}</td>
            <td>{formatCompact(e.inputTokens + e.outputTokens)}</td>
            <td>{formatCredits(e.creditsConsumed)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MainTabsPanel({
  models, capabilities, employees
}: Readonly<{ models: readonly ModelUsage[]; capabilities: readonly CapabilityUsage[]; employees: readonly EmployeeUsage[] }>) {
  const [active, setActive] = useState<MainTabId>("models");
  return (
    <Card className="usage-v2-card">
      <div className="usage-v2__tabs" role="tablist" aria-label="Usage breakdown">
        {MAIN_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`usage-v2__tab ${active === tab.id ? "usage-v2__tab--active" : ""}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="usage-v2__tab-content">
        {active === "models" ? <ModelsPanel data={models} /> : null}
        {active === "capabilities" ? <CapabilitiesPanel data={capabilities} /> : null}
        {active === "employees" ? <EmployeesPanel data={employees} /> : null}
      </div>
    </Card>
  );
}

function PeriodSpendCard({ summary }: Readonly<{ summary: UsageSummary }>) {
  return (
    <Card className="usage-v2-card">
      <div className="usage-v2__period-header">
        <p className="usage-v2__eyebrow">This period</p>
        <Link href="/usage/buy-credits" className="usage-v2__buy-credits-button">
          <Zap size={13} strokeWidth={2} aria-hidden="true" />
          Buy credits
        </Link>
      </div>
      <p className="usage-v2__sidebar-stat">
        {formatCredits(summary.usedCredits)}
        <span className="usage-v2__sidebar-stat-of"> / {formatCredits(summary.monthlyAllowanceCredits)} credits</span>
      </p>
      <div className="usage-v2__progress-track">
        <div className="usage-v2__progress-fill" style={{ width: `${Math.min(summary.usagePercentage, 100)}%` }} />
      </div>
      <div className="usage-v2__period-footer">
        <span>{formatCredits(summary.remainingCredits)} credits remaining</span>
        <span>{summary.usagePercentage}% used</span>
      </div>
      {summary.estimatedOverageAmountMinor > 0 ? (
        <p className="usage-v2__hint">Est. overage: {formatINR(summary.estimatedOverageAmountMinor)}</p>
      ) : null}
    </Card>
  );
}

function TokensSparklineCard({ total, trend }: Readonly<{ total: number; trend: readonly TrendPoint[] }>) {
  const chartData = trend.map((p) => ({ date: p.date, label: formatShortDate(p.date), totalTokens: p.totalTokens }));
  return (
    <Card className="usage-v2-card">
      <p className="usage-v2__eyebrow">Total tokens</p>
      <p className="usage-v2__sidebar-stat">{formatCompact(total)}</p>
      {chartData.length > 0 ? (
        <div className="usage-v2__sparkline">
          <ResponsiveContainer width="100%" height={72}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--muted)" }} tickMargin={4} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <Tooltip
                formatter={(value) => [Number(value).toLocaleString(), "Tokens"]}
                contentStyle={{ fontSize: "0.76rem", borderRadius: 8, padding: "4px 8px" }}
              />
              <Line type="monotone" dataKey="totalTokens" stroke="#0f9d58" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="usage-v2__muted">No token usage yet.</p>
      )}
    </Card>
  );
}

function RequestsMiniBarCard({ total, trend }: Readonly<{ total: number; trend: readonly TrendPoint[] }>) {
  const chartData = trend.map((p) => ({ date: p.date, label: formatShortDate(p.date), requests: p.requests }));
  return (
    <Card className="usage-v2-card">
      <p className="usage-v2__eyebrow">Total requests</p>
      <p className="usage-v2__sidebar-stat">{total.toLocaleString()}</p>
      {chartData.length > 0 ? (
        <div className="usage-v2__sparkline">
          <ResponsiveContainer width="100%" height={72}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--muted)" }} tickMargin={4} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <Tooltip
                formatter={(value) => [Number(value).toLocaleString(), "Requests"]}
                contentStyle={{ fontSize: "0.76rem", borderRadius: 8, padding: "4px 8px" }}
              />
              <Bar dataKey="requests" fill="#6366f1" radius={[2, 2, 0, 0]} maxBarSize={10} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="usage-v2__muted">No requests yet.</p>
      )}
    </Card>
  );
}

type ListTabId = "users" | "employees" | "models";
const LIST_TABS: readonly { id: ListTabId; label: string }[] = [
  { id: "users", label: "Users" },
  { id: "employees", label: "Employees" },
  { id: "models", label: "Models" }
];

function RankedList({
  rows
}: Readonly<{ rows: readonly { key: string; label: string; value: string }[] }>) {
  if (!rows.length) return <p className="usage-v2__muted">No data for this period.</p>;
  return (
    <ul className="usage-v2__ranked-list">
      {rows.map((row) => (
        <li key={row.key} className="usage-v2__ranked-row">
          <span className="usage-v2__ranked-avatar" aria-hidden="true">{row.label.charAt(0).toUpperCase() || "?"}</span>
          <span className="usage-v2__ranked-label">{row.label}</span>
          <span className="usage-v2__ranked-value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

function SidebarListsCard({
  users, employees, models
}: Readonly<{ users: readonly UserUsage[]; employees: readonly EmployeeUsage[]; models: readonly ModelUsage[] }>) {
  const [active, setActive] = useState<ListTabId>("users");
  const rows = useMemo(() => {
    if (active === "users")
      return [...users]
        .sort((a, b) => b.executions - a.executions)
        .slice(0, 8)
        .map((u) => ({ key: u.userId, label: u.name, value: u.executions.toLocaleString() }));
    if (active === "employees")
      return [...employees]
        .sort((a, b) => b.executions - a.executions)
        .slice(0, 8)
        .map((e) => ({ key: e.pluginInstallationId, label: e.employeeName, value: e.executions.toLocaleString() }));
    return [...models]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 8)
      .map((m, i) => ({ key: `${m.provider}-${m.model}-${i}`, label: m.model, value: formatCompact(m.totalTokens) }));
  }, [active, users, employees, models]);

  return (
    <Card className="usage-v2-card">
      <div className="usage-v2__tabs usage-v2__tabs--compact" role="tablist" aria-label="Usage by">
        {LIST_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`usage-v2__tab ${active === tab.id ? "usage-v2__tab--active" : ""}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <RankedList rows={rows} />
    </Card>
  );
}

export function BillingPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [start, setStart] = useState(() => daysAgo(30));
  const [end, setEnd] = useState(todayString);

  const onDateChange = useCallback((s: string, e: string) => {
    setStart(s);
    setEnd(e);
  }, []);

  const summary = useQuery({ queryKey: ["billing", "summary", start, end], queryFn: () => api.summary(start, end) });
  const employees = useQuery({ queryKey: ["billing", "employees", start, end], queryFn: () => api.byEmployee(start, end) });
  const capabilities = useQuery({ queryKey: ["billing", "capabilities", start, end], queryFn: () => api.byCapability(start, end) });
  const models = useQuery({ queryKey: ["billing", "models", start, end], queryFn: () => api.byModel(start, end) });
  const trendData = useQuery({ queryKey: ["billing", "trend", start, end], queryFn: () => api.trend(start, end) });
  const users = useQuery({ queryKey: ["billing", "users", start, end], queryFn: () => api.byUser(start, end) });

  const isLoading = summary.isLoading || employees.isLoading || capabilities.isLoading || models.isLoading || trendData.isLoading || users.isLoading;
  const isFetching = summary.isFetching || employees.isFetching || capabilities.isFetching || models.isFetching || trendData.isFetching || users.isFetching;
  const isError = summary.isError || employees.isError || capabilities.isError || models.isError || trendData.isError || users.isError;
  const data = summary.data;
  const trend = trendData.data ?? [];

  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["billing"] });
  }, [queryClient]);

  return (
    <AccessGate permission="usage.read">
      <section className="usage-v2">
        <PageHeader
          title="Usage"
          description="Track AI-credit spend, tokens, and requests across your organisation."
          action={
            <UsageToolbar
              start={start}
              end={end}
              onChange={onDateChange}
              onRefresh={onRefresh}
              onExport={() => downloadTrendCsv(trend)}
              isFetching={isFetching}
            />
          }
        />

        {isLoading ? (
          <div className="usage-v2__layout">
            <div className="usage-v2__main"><Card className="usage-v2-card"><Skeleton /></Card></div>
            <div className="usage-v2__sidebar"><Card className="usage-v2-card"><Skeleton /></Card></div>
          </div>
        ) : isError ? (
          <Card className="usage-v2-card"><p className="usage-v2__error">We couldn&apos;t load usage information. Please try again.</p></Card>
        ) : !data ? (
          <Card className="usage-v2-card"><EmptyState title="No usage data" description="No AI usage has been recorded during this period." /></Card>
        ) : (
          <div className="usage-v2__layout">
            <div className="usage-v2__main">
              <HeadlineSpendCard summary={data} trend={trend} />
              <MainTabsPanel
                models={models.data ?? []}
                capabilities={capabilities.data ?? []}
                employees={employees.data ?? []}
              />
            </div>
            <div className="usage-v2__sidebar">
              <PeriodSpendCard summary={data} />
              <TokensSparklineCard total={data.tokens.total} trend={trend} />
              <RequestsMiniBarCard total={data.totalRequests} trend={trend} />
              <SidebarListsCard users={users.data ?? []} employees={employees.data ?? []} models={models.data ?? []} />
            </div>
          </div>
        )}
      </section>
    </AccessGate>
  );
}
