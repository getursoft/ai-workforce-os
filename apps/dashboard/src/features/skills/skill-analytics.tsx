"use client";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Input, Label, Skeleton, SummaryCard } from "../../components/ui";
import { useApi, queryKey } from "./skill-pages";
import type { SkillAnalyticsRow } from "./skill-api";

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function AnalyticsRowTable({ title, rows }: Readonly<{ title: string; rows: SkillAnalyticsRow[] }>) {
  return (
    <Card>
      <h2>{title}</h2>
      {rows.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Category</th>
                <th>Executions</th>
                <th>Success</th>
                <th>Avg latency</th>
                <th>Credits</th>
                <th>Employees</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.skillKey}>
                  <td>
                    <strong>{row.name}</strong>
                    <br />
                    <small style={{ color: "var(--muted)" }}>{row.skillKey}</small>
                  </td>
                  <td>{row.category}</td>
                  <td>{row.executions}</td>
                  <td>{percent(row.successRate)}</td>
                  <td>{row.avgLatencyMs} ms</td>
                  <td>{row.creditsConsumed}</td>
                  <td>{row.employeesUsing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "var(--muted)" }}>No data for the current filters.</p>
      )}
    </Card>
  );
}

/** Sprint 6.1B Feature 4 — Skill Analytics tab. Reads exclusively from the same billing/execution
 *  rows the runtime already writes, so these numbers never drift from what was actually billed. */
export function AnalyticsTab() {
  const api = useApi();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [skillKey, setSkillKey] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);

  const filters = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(skillKey.trim() ? { skillKey: skillKey.trim() } : {})
  };

  const analytics = useQuery({
    queryKey: [...queryKey, "analytics", from, to, skillKey],
    queryFn: () => api.analytics(filters)
  });

  const exportCsv = useMutation({
    mutationFn: () => api.analyticsExportCsv(filters),
    onSuccess: (blob) => {
      setExportError(null);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "skill-analytics.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
    onError: (error) => {
      setExportError(error instanceof Error ? error.message : "CSV export failed");
    }
  });

  return (
    <>
      <Card className="admin-toolbar">
        <Label htmlFor="analytics-from">From</Label>
        <Input id="analytics-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Label htmlFor="analytics-to">To</Label>
        <Input id="analytics-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <Label htmlFor="analytics-skill-key">Skill key</Label>
        <Input
          id="analytics-skill-key"
          value={skillKey}
          onChange={(event) => setSkillKey(event.target.value)}
          placeholder="e.g. document-summarizer"
        />
      </Card>
      <div className="admin-actions">
        <Button loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          Export CSV
        </Button>
      </div>
      {exportError ? <Alert tone="danger" title="CSV export failed">{exportError}</Alert> : null}

      {analytics.isLoading ? (
        <Skeleton />
      ) : analytics.isError ? (
        <Alert tone="danger" title="Unable to load analytics">
          <Button onClick={() => analytics.refetch()}>Retry</Button>
        </Alert>
      ) : analytics.data ? (
        <div style={{ display: "grid", gap: 16 }}>
          <div className="admin-grid">
            <SummaryCard title="Executions" value={analytics.data.totals.executions} />
            <SummaryCard title="Success rate" value={percent(analytics.data.totals.successRate)} />
            <SummaryCard title="Failure rate" value={percent(analytics.data.totals.failureRate)} />
            <SummaryCard title="Avg latency" value={`${analytics.data.totals.avgLatencyMs} ms`} />
            <SummaryCard title="Credits consumed" value={analytics.data.totals.creditsConsumed} />
            <SummaryCard title="Total tokens" value={analytics.data.totals.totalTokens} />
            <SummaryCard title="Employees using skills" value={analytics.data.totals.employeesUsing} />
          </div>

          <AnalyticsRowTable title="Top Skills" rows={analytics.data.topSkills} />
          <AnalyticsRowTable title="Most Failed" rows={analytics.data.mostFailed} />
          <AnalyticsRowTable title="Slowest" rows={analytics.data.slowestSkills} />
          <AnalyticsRowTable title="Most Granted" rows={analytics.data.mostGranted} />
        </div>
      ) : null}
    </>
  );
}
