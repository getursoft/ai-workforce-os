"use client";

import { useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, Legend, PieChart, Pie, Cell, type PieLabelRenderProps
} from "recharts";
import { useAuth } from "../auth/auth-provider";
import { createBillingApi, type UsageSummary } from "./billing-api";
import { AccessGate } from "../admin/authorization";
import { Badge, Button, Card, EmptyState, Label, PageHeader, Skeleton } from "../../components/ui";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createBillingApi(client), [client]);
}

const CHART_COLORS = ["#1d4ed8", "#0f9d58", "#b7791f", "#c2410c", "#6366f1", "#ec4899"];

function formatCredits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatINR(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

function ThresholdBadge({ threshold }: { threshold: UsageSummary["threshold"] }) {
  const tones: Record<string, "success" | "warning" | "danger" | "neutral"> = {
    NORMAL: "success", INFORMATIONAL: "warning", WARNING: "danger", LIMIT_REACHED: "danger", OVERAGE: "danger"
  };
  const labels: Record<string, string> = {
    NORMAL: "Normal", INFORMATIONAL: "Caution", WARNING: "High Usage", LIMIT_REACHED: "Limit Reached", OVERAGE: "Overage Active"
  };
  return <Badge tone={tones[threshold] ?? "neutral"}>{labels[threshold] ?? threshold}</Badge>;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(): string {
  const d = new Date();
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1).toISOString().slice(0, 10);
}

function DateRangeFilter({
  start, end, onChange
}: Readonly<{
  start: string; end: string;
  onChange(s: string, e: string): void;
}>) {
  return (
    <div className="usage-date-filter">
      <Label>From</Label>
      <input type="date" className="ui-input" value={start} max={end}
        onChange={(e) => onChange(e.target.value, end)} />
      <Label>To</Label>
      <input type="date" className="ui-input" value={end} min={start} max={todayString()}
        onChange={(e) => onChange(start, e.target.value)} />
    </div>
  );
}

function SummaryCards({ data }: Readonly<{ data: UsageSummary }>) {
  return (
    <>
      <Card><h3>Current Plan</h3><p className="admin-stat">{data.plan?.name ?? "N/A"}</p></Card>
      <Card><h3>Monthly Allowance</h3><p className="admin-stat">{formatCredits(data.monthlyAllowanceCredits)} credits</p></Card>
      <Card><h3>Used</h3><p className="admin-stat">{formatCredits(data.usedCredits)} credits</p></Card>
      <Card><h3>Remaining</h3><p className="admin-stat">{formatCredits(data.remainingCredits)} credits</p></Card>
      <Card><h3>Total Requests</h3><p className="admin-stat">{data.totalRequests.toLocaleString()}</p></Card>
      <Card><h3>Est. Overage</h3><p className="admin-stat">{formatINR(data.estimatedOverageAmountMinor)}</p></Card>
      {data.billingCycle ? (
        <Card><h3>Billing Cycle</h3><p className="admin-stat">{new Date(data.billingCycle.start).toLocaleDateString()} – {new Date(data.billingCycle.end).toLocaleDateString()}</p></Card>
      ) : null}
    </>
  );
}

function CreditTrendChart({ data }: Readonly<{ data: Array<{ date: string; creditsConsumed: number }> }>) {
  return (
    <Card>
      <h3>Consumed Credits Trend</h3>
      <div className="usage-chart">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="creditGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={8} />
            <YAxis tick={{ fontSize: 11 }} tickMargin={8} />
            <Tooltip />
            <Area type="monotone" dataKey="creditsConsumed" name="Credits" stroke="#1d4ed8" fill="url(#creditGradient)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function TokenTrendChart({ data }: Readonly<{ data: Array<{ date: string; inputTokens: number; outputTokens: number }> }>) {
  return (
    <Card>
      <h3>Token Trend</h3>
      <div className="usage-chart">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={8} />
            <YAxis tick={{ fontSize: 11 }} tickMargin={8} />
            <Tooltip />
            <Legend />
            <Bar dataKey="inputTokens" name="Input" stackId="a" fill="#1d4ed8" />
            <Bar dataKey="outputTokens" name="Output" stackId="a" fill="#0f9d58" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function InputOutputSplit({ inputTokens, outputTokens }: Readonly<{ inputTokens: number; outputTokens: number }>) {
  const total = inputTokens + outputTokens;
  if (total === 0) return <Card><h3>Input vs Output Tokens</h3><p>No token data for this period.</p></Card>;
  const data = [
    { name: "Input", value: inputTokens },
    { name: "Output", value: outputTokens }
  ];
  return (
    <Card>
      <h3>Input vs Output Tokens</h3>
      <div className="usage-chart usage-chart--pie">
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" label={(props: PieLabelRenderProps) => {
              const p = typeof props.percent === "number" ? props.percent : 0;
              return `${props.name} ${(p * 100).toFixed(0)}%`;
            }}>
              {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i] || "#888"} />)}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="usage-token-legend">
        <span><span className="usage-dot" style={{ background: CHART_COLORS[0] }} /> Input: {formatTokens(inputTokens)}</span>
        <span><span className="usage-dot" style={{ background: CHART_COLORS[1] }} /> Output: {formatTokens(outputTokens)}</span>
      </div>
    </Card>
  );
}

function RequestTrendChart({ data }: Readonly<{ data: Array<{ date: string; requests: number }> }>) {
  return (
    <Card>
      <h3>Requests Over Time</h3>
      <div className="usage-chart">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickMargin={8} />
            <YAxis tick={{ fontSize: 11 }} tickMargin={8} allowDecimals={false} />
            <Tooltip />
            <Line type="monotone" dataKey="requests" name="Requests" stroke="#6366f1" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function BillingPage() {
  const api = useApi();
  const [start, setStart] = useState(monthStart);
  const [end, setEnd] = useState(todayString);
  const [showAllCharts, setShowAllCharts] = useState(false);

  const onDateChange = useCallback((s: string, e: string) => {
    setStart(s);
    setEnd(e);
  }, []);

  const summary = useQuery({
    queryKey: ["billing", "summary", start, end],
    queryFn: () => api.summary(start, end)
  });
  const employees = useQuery({
    queryKey: ["billing", "employees", start, end],
    queryFn: () => api.byEmployee(start, end)
  });
  const capabilities = useQuery({
    queryKey: ["billing", "capabilities", start, end],
    queryFn: () => api.byCapability(start, end)
  });
  const models = useQuery({
    queryKey: ["billing", "models", start, end],
    queryFn: () => api.byModel(start, end)
  });
  const trendData = useQuery({
    queryKey: ["billing", "trend", start, end],
    queryFn: () => api.trend(start, end)
  });
  const users = useQuery({
    queryKey: ["billing", "users", start, end],
    queryFn: () => api.byUser(start, end)
  });

  const isLoading = summary.isLoading || employees.isLoading || capabilities.isLoading || models.isLoading || trendData.isLoading || users.isLoading;
  const isError = summary.isError || employees.isError || capabilities.isError || models.isError || trendData.isError || users.isError;
  const data = summary.data;

  return (
    <AccessGate permission="usage.read">
      <section className="admin-page">
        <PageHeader title="Usage Overview" description="Monitor your organisation's AI-credit consumption, token trends, and usage breakdowns." />

        <DateRangeFilter start={start} end={end} onChange={onDateChange} />

        {isLoading ? (
          <Card><Skeleton /></Card>
        ) : isError ? (
          <Card><p className="admin-page__error">We couldn't load usage information. Please try again.</p></Card>
        ) : !data ? (
          <Card><EmptyState title="No usage data" description="No AI usage has been recorded during this period." /></Card>
        ) : (
          <>
            <div className="admin-grid">
              <SummaryCards data={data} />
            </div>

            <Card>
              <div className="admin-flex">
                <div><strong>{formatCredits(data.usedCredits)} of {formatCredits(data.monthlyAllowanceCredits)} credits used</strong></div>
                <ThresholdBadge threshold={data.threshold} />
              </div>
              <div className="admin-progress-bar">
                <div className="admin-progress-fill" style={{ width: `${Math.min(data.usagePercentage, 100)}%` }} />
              </div>
              <p className="admin-stat-large">{data.usagePercentage}%</p>
              {data.threshold === "INFORMATIONAL" ? <p>Your organisation has used 70% of its monthly AI-credit allowance.</p> : null}
              {data.threshold === "WARNING" ? <p>Your organisation is approaching its monthly AI-credit limit.</p> : null}
              {data.threshold === "OVERAGE" ? <p>Overage billing is now active.</p> : null}
            </Card>

            <Card><h3>Token Usage</h3>
              <div className="admin-grid">
                <div><Label>Input tokens</Label><p>{formatTokens(data.tokens.input)}</p></div>
                <div><Label>Output tokens</Label><p>{formatTokens(data.tokens.output)}</p></div>
                <div><Label>Total tokens</Label><p>{formatTokens(data.tokens.total)}</p></div>
              </div>
            </Card>

            {trendData.data && trendData.data.length > 0 && !showAllCharts ? (
              <div className="usage-charts-compact">
                <CreditTrendChart data={trendData.data} />
                <InputOutputSplit inputTokens={data.tokens.input} outputTokens={data.tokens.output} />
              </div>
            ) : null}

            {trendData.data && trendData.data.length > 0 && showAllCharts ? (
              <>
                <div className="usage-charts-compact">
                  <CreditTrendChart data={trendData.data} />
                  <TokenTrendChart data={trendData.data} />
                </div>
                <div className="usage-charts-compact">
                  <RequestTrendChart data={trendData.data} />
                  <InputOutputSplit inputTokens={data.tokens.input} outputTokens={data.tokens.output} />
                </div>
              </>
            ) : null}

            {trendData.data && trendData.data.length > 0 ? (
              <div className="admin-actions">
                <Button variant="ghost" onClick={() => setShowAllCharts((v) => !v)}>
                  {showAllCharts ? "Show less charts" : "Show all charts"}
                </Button>
              </div>
            ) : null}

            <Card><h3>Usage by AI Employee</h3>
              {employees.data?.length ? (
                <div className="admin-table-wrap"><table className="admin-table">
                  <thead><tr><th>Employee</th><th>Credits</th><th>Share</th><th>Input</th><th>Output</th><th>Executions</th></tr></thead>
                  <tbody>{employees.data.map((e) => (
                    <tr key={e.pluginInstallationId}>
                      <td>{e.employeeName}</td><td>{formatCredits(e.creditsConsumed)}</td>
                      <td>{e.sharePercentage}%</td><td>{formatTokens(e.inputTokens)}</td>
                      <td>{formatTokens(e.outputTokens)}</td><td>{e.executions}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <p>No usage data for this period.</p>}
            </Card>

            <Card><h3>Usage by Capability</h3>
              {capabilities.data?.length ? (
                <div className="admin-table-wrap"><table className="admin-table">
                  <thead><tr><th>Capability</th><th>Credits</th><th>Share</th></tr></thead>
                  <tbody>{capabilities.data.map((c) => (
                    <tr key={c.capability}>
                      <td>{c.displayName}</td><td>{formatCredits(c.creditsConsumed)}</td>
                      <td>{c.sharePercentage}%</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <p>No capability data for this period.</p>}
            </Card>

            <Card><h3>Usage by Model</h3>
              {models.data?.length ? (
                <div className="admin-table-wrap"><table className="admin-table">
                  <thead><tr><th>Provider</th><th>Model</th><th>Input</th><th>Output</th><th>Total</th><th>Credits</th></tr></thead>
                  <tbody>{models.data.map((m, i) => (
                    <tr key={`${m.provider}-${m.model}-${i}`}>
                      <td>{m.provider}</td><td>{m.model}</td>
                      <td>{formatTokens(m.inputTokens)}</td><td>{formatTokens(m.outputTokens)}</td>
                      <td>{formatTokens(m.totalTokens)}</td><td>{formatCredits(m.creditsConsumed)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <p>No model data for this period.</p>}
            </Card>

            <Card><h3>Usage by User</h3>
              {users.data?.length ? (
                <div className="admin-table-wrap"><table className="admin-table">
                  <thead><tr><th>User</th><th>Email</th><th>Credits</th><th>Share</th><th>Input</th><th>Output</th><th>Executions</th></tr></thead>
                  <tbody>{users.data.map((u) => (
                    <tr key={u.userId}>
                      <td>{u.name}</td><td>{u.email}</td>
                      <td>{formatCredits(u.creditsConsumed)}</td><td>{u.sharePercentage}%</td>
                      <td>{formatTokens(u.inputTokens)}</td><td>{formatTokens(u.outputTokens)}</td>
                      <td>{u.executions}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              ) : <p>No user usage data for this period.</p>}
            </Card>
          </>
        )}
      </section>
    </AccessGate>
  );
}
