"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, Line, LineChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAuth } from "../auth/auth-provider";
import { AccessGate } from "../admin/authorization";
import { Alert, Badge, Button, Card, Dialog, PageHeader, Skeleton } from "../../components/ui";
import { createObservabilityApi, type ErrorFingerprint, type HealthStatus, type SpanNode, type TraceListItem } from "./observability-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createObservabilityApi(client), [client]);
}

const TRACE_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  COMPLETED: "success",
  RUNNING: "warning",
  FAILED: "danger"
};

const ALERT_SEVERITY_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  INFO: "neutral",
  WARNING: "warning",
  CRITICAL: "danger"
};

const HEALTH_STATUS_TONE: Record<HealthStatus, "success" | "warning" | "danger" | "neutral"> = {
  HEALTHY: "success",
  DEGRADED: "warning",
  UNHEALTHY: "danger",
  UNKNOWN: "neutral"
};

function durationLabel(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function SpanTree({ node, depth, onSelect }: { node: SpanNode; depth: number; onSelect: (node: SpanNode) => void }) {
  return (
    <>
      <li className="dashboard-activity-list__row" style={{ paddingLeft: depth * 16, cursor: "pointer" }} onClick={() => onSelect(node)}>
        <span className="dashboard-activity-list__label">
          {depth > 0 ? "↳ " : ""}
          {node.name} <Badge tone={TRACE_STATUS_TONE[node.status] ?? "neutral"}>{node.status}</Badge>
        </span>
        <span className="dashboard-activity-list__time">{durationLabel(node.durationMs)}</span>
      </li>
      {node.children.map((child) => (
        <SpanTree key={child.spanId} node={child} depth={depth + 1} onSelect={onSelect} />
      ))}
    </>
  );
}

export function ObservabilityPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [selectedTrace, setSelectedTrace] = useState<TraceListItem | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<SpanNode | null>(null);

  const overviewQuery = useQuery({ queryKey: ["observability", "overview"], queryFn: api.overview, refetchInterval: 15000 });
  const healthQuery = useQuery({ queryKey: ["observability", "health"], queryFn: api.health, refetchInterval: 30000 });
  const metricsQuery = useQuery({ queryKey: ["observability", "metrics"], queryFn: api.metrics, refetchInterval: 30000 });
  const tracesQuery = useQuery({ queryKey: ["observability", "traces"], queryFn: () => api.listTraces({ pageSize: 25 }), refetchInterval: 15000 });
  const alertsQuery = useQuery({ queryKey: ["observability", "alerts"], queryFn: () => api.listAlerts("OPEN"), refetchInterval: 15000 });
  const errorsQuery = useQuery({ queryKey: ["observability", "errors"], queryFn: api.errors, refetchInterval: 30000 });
  const treeQuery = useQuery({
    queryKey: ["observability", "trace-tree", selectedTrace?.traceId],
    queryFn: () => api.getTraceTree(selectedTrace?.traceId ?? ""),
    enabled: Boolean(selectedTrace)
  });

  const overview = overviewQuery.data;
  const health = healthQuery.data ?? [];
  const traces = tracesQuery.data?.items ?? [];
  const alerts = alertsQuery.data ?? [];
  const errors = errorsQuery.data ?? [];
  const executionsOverTime = metricsQuery.data?.executionsOverTime ?? [];
  const failuresByEmployee = metricsQuery.data?.failuresByEmployee ?? [];

  const refresh = () => qc.invalidateQueries({ queryKey: ["observability"] });

  return (
    <AccessGate permission="observability.read">
      <section className="admin-page">
        <PageHeader
          eyebrow="Platform health"
          title="Observability"
          description="One correlated trace across employees, workflows, approvals, providers and channels for every request."
        />

        <section className="dashboard-grid dashboard-grid--summary" aria-label="Summary">
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Executions</p>
            <p className="dashboard-stat-card__value">{overview?.totalExecutions ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Success rate</p>
            <p className="dashboard-stat-card__value">{overview?.successRate === null || overview?.successRate === undefined ? "—" : `${Math.round(overview.successRate * 100)}%`}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">p50 latency</p>
            <p className="dashboard-stat-card__value">{durationLabel(overview?.p50LatencyMs ?? null)}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">p95 latency</p>
            <p className="dashboard-stat-card__value">{durationLabel(overview?.p95LatencyMs ?? null)}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Total tokens</p>
            <p className="dashboard-stat-card__value">{overview?.tokens.totalTokens ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Est. credits</p>
            <p className="dashboard-stat-card__value">{overview?.estimatedCredits ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Running workflows</p>
            <p className="dashboard-stat-card__value">{overview?.runningWorkflows ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Stuck workflows</p>
            <p className="dashboard-stat-card__value">{overview?.stuckWorkflows ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Active delegated tasks</p>
            <p className="dashboard-stat-card__value">{overview?.activeDelegatedTasks ?? "—"}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Open alerts</p>
            <p className="dashboard-stat-card__value">{overview?.openAlerts ?? "—"}</p>
          </Card>
        </section>

        <div className="admin-section-header">
          <h2>Live health</h2>
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {healthQuery.isLoading ? (
          <Skeleton />
        ) : (
          <div className="admin-grid">
            {health.map((component) => (
              <div key={component.component} className="admin-grid-card">
                <div>
                  <strong>{component.component}</strong>
                  <p>{component.detail}</p>
                </div>
                <Badge tone={HEALTH_STATUS_TONE[component.status]}>{component.status}</Badge>
              </div>
            ))}
          </div>
        )}

        <div className="admin-section-header">
          <h2>Executions over time</h2>
        </div>
        {metricsQuery.isLoading ? (
          <Skeleton className="dashboard-home__chart-skeleton" />
        ) : executionsOverTime.length === 0 ? (
          <p className="dashboard-home__muted">No execution history yet.</p>
        ) : (
          <div className="dashboard-home__chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={executionsOverTime.map((row) => ({ date: row.day, total: row.total, failed: row.failed }))}>
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }} />
                <Legend wrapperStyle={{ fontSize: "0.75rem" }} />
                <Line type="monotone" dataKey="total" name="Total" stroke="var(--accent, #4f7cff)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="failed" name="Failed" stroke="var(--danger, #e5484d)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="admin-section-header">
          <h2>Failures by employee</h2>
        </div>
        {metricsQuery.isLoading ? (
          <Skeleton className="dashboard-home__chart-skeleton" />
        ) : failuresByEmployee.length === 0 ? (
          <p className="dashboard-home__muted">No failures recorded.</p>
        ) : (
          <div className="dashboard-home__chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={failuresByEmployee.map((row) => ({ employee: row.employeeInstallationId.slice(0, 8), failures: row.failureCount }))}>
                <XAxis dataKey="employee" tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "var(--muted)" }} axisLine={false} tickLine={false} width={40} />
                <Tooltip contentStyle={{ fontSize: "0.8rem", borderRadius: 10 }} />
                <Bar dataKey="failures" name="Failures" fill="var(--danger, #e5484d)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="admin-section-header">
          <h2>Open alerts</h2>
        </div>
        {alertsQuery.isLoading ? (
          <Skeleton />
        ) : alerts.length === 0 ? (
          <p className="dashboard-home__muted">No open alerts.</p>
        ) : (
          <div className="admin-grid">
            {alerts.map((alert) => (
              <div key={alert.id} className="admin-grid-card">
                <div>
                  <strong>{alert.title}</strong>
                  <p>
                    {alert.ruleCode} · {new Date(alert.createdAt).toLocaleString()}
                  </p>
                </div>
                <div style={{ textAlign: "right" }}>
                  <Badge tone={ALERT_SEVERITY_TONE[alert.severity] ?? "neutral"}>{alert.severity}</Badge>
                  <div style={{ marginTop: 8 }}>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        await api.acknowledgeAlert(alert.id);
                        await refresh();
                      }}
                    >
                      Acknowledge
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="admin-section-header">
          <h2>Error explorer</h2>
        </div>
        {errorsQuery.isLoading ? (
          <Skeleton />
        ) : errors.length === 0 ? (
          <p className="dashboard-home__muted">No errors recorded.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Fingerprint</th>
                  <th>Component</th>
                  <th>Error code</th>
                  <th>Count</th>
                  <th>Affected traces</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Retryable</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((row: ErrorFingerprint) => (
                  <tr key={row.fingerprint}>
                    <td>
                      <code>{row.fingerprint}</code>
                    </td>
                    <td>{row.component}</td>
                    <td>{row.errorCode}</td>
                    <td>{row.occurrenceCount}</td>
                    <td>{row.affectedTraceCount}</td>
                    <td>{new Date(row.firstSeen).toLocaleString()}</td>
                    <td>{new Date(row.lastSeen).toLocaleString()}</td>
                    <td>
                      <Badge tone={row.retryable ? "warning" : "neutral"}>{row.retryable ? "Retryable" : "Terminal"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="admin-section-header">
          <h2>Trace explorer</h2>
        </div>
        {tracesQuery.isLoading ? (
          <Skeleton />
        ) : traces.length === 0 ? (
          <p className="dashboard-home__muted">No traces recorded yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Trace ID</th>
                  <th>Actor</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Started</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace) => (
                  <tr key={trace.id} onClick={() => setSelectedTrace(trace)} style={{ cursor: "pointer" }}>
                    <td>
                      <code>{trace.traceId.slice(0, 12)}…</code>
                    </td>
                    <td>{trace.actorType}</td>
                    <td>
                      <Badge tone={TRACE_STATUS_TONE[trace.status] ?? "neutral"}>{trace.status}</Badge>
                    </td>
                    <td>{durationLabel(trace.durationMs)}</td>
                    <td>{new Date(trace.startedAt).toLocaleString()}</td>
                    <td>{trace.errorCode ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedTrace ? (
        <Dialog open onCancel={() => setSelectedTrace(null)} onConfirm={() => setSelectedTrace(null)} title="Trace detail" confirmLabel="Close" showActions>
          <dl>
            <dt>Trace ID</dt>
            <dd>
              <code>{selectedTrace.traceId}</code>
            </dd>
            <dt>Status</dt>
            <dd>
              <Badge tone={TRACE_STATUS_TONE[selectedTrace.status] ?? "neutral"}>{selectedTrace.status}</Badge>
            </dd>
            <dt>Duration</dt>
            <dd>{durationLabel(selectedTrace.durationMs)}</dd>
            {selectedTrace.errorCode ? (
              <>
                <dt>Error</dt>
                <dd>
                  {selectedTrace.errorCode}: {selectedTrace.errorMessageSafe}
                </dd>
              </>
            ) : null}
          </dl>
          <h3>Span tree</h3>
          <p className="dashboard-home__muted">Click a span to inspect its attributes (provider timing, tool/connector, memory/knowledge counts).</p>
          {treeQuery.isLoading ? (
            <Skeleton />
          ) : treeQuery.data?.root ? (
            <ul className="dashboard-activity-list">
              <SpanTree node={treeQuery.data.root} depth={0} onSelect={setSelectedSpan} />
            </ul>
          ) : (
            <p className="dashboard-home__muted">No spans recorded for this trace.</p>
          )}
        </Dialog>
      ) : null}

      {selectedSpan ? (
        <Dialog open onCancel={() => setSelectedSpan(null)} onConfirm={() => setSelectedSpan(null)} title={selectedSpan.name} confirmLabel="Close" showActions>
          <dl>
            <dt>Type</dt>
            <dd>{selectedSpan.spanType}</dd>
            <dt>Component</dt>
            <dd>{selectedSpan.component}</dd>
            <dt>Status</dt>
            <dd>
              <Badge tone={TRACE_STATUS_TONE[selectedSpan.status] ?? "neutral"}>{selectedSpan.status}</Badge>
            </dd>
            <dt>Duration</dt>
            <dd>{durationLabel(selectedSpan.durationMs)}</dd>
            {selectedSpan.errorCode ? (
              <>
                <dt>Error</dt>
                <dd>
                  {selectedSpan.errorCode}: {selectedSpan.errorMessageSafe}
                </dd>
              </>
            ) : null}
          </dl>
          <h3>Attributes</h3>
          {selectedSpan.attributes ? (
            <pre className="admin-code-block">{JSON.stringify(selectedSpan.attributes, null, 2)}</pre>
          ) : (
            <p className="dashboard-home__muted">No attributes recorded for this span.</p>
          )}
        </Dialog>
      ) : null}

      {overviewQuery.isError || tracesQuery.isError ? (
        <Alert tone="danger" title="Unable to load observability data">
          <Button onClick={() => refresh()}>Retry</Button>
        </Alert>
      ) : null}
    </AccessGate>
  );
}
