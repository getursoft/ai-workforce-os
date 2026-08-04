"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { AccessGate } from "../admin/authorization";
import { Badge, Button, Card, Input, PageHeader, Skeleton, SummaryCard } from "../../components/ui";
import { createSchedulerApi, type JobTemplate, type SchedulerExecution, type WorkerHealth } from "./scheduler-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createSchedulerApi(client), [client]);
}

const JOB_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  COMPLETED: "neutral",
  CANCELLED: "neutral",
  FAILED: "danger"
};

const EXECUTION_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  COMPLETED: "success",
  RUNNING: "warning",
  QUEUED: "neutral",
  RETRYING: "warning",
  FAILED: "danger",
  TIMEOUT: "danger",
  DEAD_LETTERED: "danger",
  CANCELLED: "neutral"
};

const PRIORITY_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  LOW: "neutral",
  NORMAL: "neutral",
  HIGH: "warning",
  URGENT: "warning",
  CRITICAL: "danger"
};

function durationLabel(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

type Tab = "overview" | "jobs" | "executions" | "templates";

export function SchedulerPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");
  const [statusFilter, setStatusFilter] = useState("");
  const [execStatusFilter, setExecStatusFilter] = useState("");

  const overviewQuery = useQuery({ queryKey: ["scheduler", "overview"], queryFn: api.overview, refetchInterval: 10_000 });
  const jobsQuery = useQuery({ queryKey: ["scheduler", "jobs", statusFilter], queryFn: () => api.listJobs({ pageSize: 100, ...(statusFilter ? { status: statusFilter } : {}) }), refetchInterval: 15_000 });
  const executionsQuery = useQuery({ queryKey: ["scheduler", "executions", execStatusFilter], queryFn: () => api.listExecutions({ pageSize: 50, ...(execStatusFilter ? { status: execStatusFilter } : {}) }), refetchInterval: 15_000 });
  const templatesQuery = useQuery({ queryKey: ["scheduler", "templates"], queryFn: api.templates });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["scheduler"] });
  };

  const pauseMutation = useMutation({ mutationFn: (id: string) => api.pauseJob(id), onSuccess: invalidate });
  const resumeMutation = useMutation({ mutationFn: (id: string) => api.resumeJob(id), onSuccess: invalidate });
  const cancelMutation = useMutation({ mutationFn: (id: string) => api.cancelJob(id), onSuccess: invalidate });
  const retryMutation = useMutation({ mutationFn: (id: string) => api.retryExecution(id), onSuccess: invalidate });
  const instantiateMutation = useMutation({
    mutationFn: ({ templateId }: { templateId: string }) => api.instantiateTemplate(templateId),
    onSuccess: () => {
      invalidate();
      setTab("jobs");
    }
  });

  const overview = overviewQuery.data;
  const jobs = jobsQuery.data?.items ?? [];
  const executions = executionsQuery.data?.items ?? [];
  const templates = templatesQuery.data ?? [];
  const worker = overview?.worker;

  const statCards = [
    { title: "Running", value: overview?.running ?? 0 },
    { title: "Queued", value: overview?.queued ?? 0 },
    { title: "Completed", value: overview?.completed ?? 0 },
    { title: "Failed", value: overview?.failed ?? 0 },
    { title: "Retrying", value: overview?.retrying ?? 0 },
    { title: "Dead Lettered", value: overview?.deadLettered ?? 0 },
    { title: "Avg Duration", value: durationLabel(overview?.averageDurationMs ?? null) },
    { title: "Active Jobs", value: overview?.activeJobs ?? 0 }
  ];

  return (
    <div className="scheduler-page">
      <PageHeader
        title="Autonomous Scheduler"
        description="Background jobs, reminders, and follow-ups that keep every AI Employee proactive."
      />

      <div className="dashboard-tabs" role="tablist">
        {(["overview", "jobs", "executions", "templates"] as Tab[]).map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            className={`dashboard-tabs__tab ${tab === item ? "dashboard-tabs__tab--active" : ""}`}
            onClick={() => setTab(item)}
          >
            {(item[0] ?? "").toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      {overviewQuery.isLoading ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="dashboard-grid dashboard-grid--stat">
          {statCards.map((card) => (
            <SummaryCard key={card.title} title={card.title} value={card.value} />
          ))}
        </div>
      )}

      {tab === "overview" ? (
        <OverviewTab worker={worker} recent={overview?.recentExecutions ?? []} upcoming={overview?.upcomingJobs ?? []} />
      ) : null}

      {tab === "jobs" ? (
        <AccessGate permission="scheduler.write">
          <div className="scheduler-toolbar">
            <Input
              aria-label="Filter by status"
              placeholder="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            />
          </div>
          <Card>
            <div className="dashboard-table-wrap">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Trigger</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Next Run</th>
                    <th>Last Run</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>{job.definitionKey}</strong>
                        <small>
                          {job.triggerType}
                          {job.cronExpression ? ` · ${job.cronExpression}` : ""}
                        </small>
                      </td>
                      <td>
                        {job.triggerType}
                        {job.intervalMs ? ` · every ${(job.intervalMs / 60000).toFixed(0)}m` : ""}
                      </td>
                      <td>
                        <Badge tone={PRIORITY_TONE[job.priority] ?? "neutral"}>{job.priority}</Badge>
                      </td>
                      <td>
                        <Badge tone={JOB_STATUS_TONE[job.status] ?? "neutral"}>{job.status}</Badge>
                      </td>
                      <td>{dateLabel(job.nextRun)}</td>
                      <td>{dateLabel(job.lastRun)}</td>
                      <td className="scheduler-actions">
                        {job.status === "ACTIVE" ? (
                          <Button variant="secondary" onClick={() => pauseMutation.mutate(job.id)}>
                            Pause
                          </Button>
                        ) : null}
                        {job.status === "PAUSED" ? (
                          <Button variant="secondary" onClick={() => resumeMutation.mutate(job.id)}>
                            Resume
                          </Button>
                        ) : null}
                        {job.status === "ACTIVE" || job.status === "PAUSED" ? (
                          <Button variant="danger" onClick={() => cancelMutation.mutate(job.id)}>
                            Cancel
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {jobs.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No scheduled jobs yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </AccessGate>
      ) : null}

      {tab === "executions" ? (
        <AccessGate permission="scheduler.read">
          <div className="scheduler-toolbar">
            <Input
              aria-label="Filter executions by status"
              placeholder="Filter by status"
              value={execStatusFilter}
              onChange={(event) => setExecStatusFilter(event.target.value)}
            />
          </div>
          <Card>
            <div className="dashboard-table-wrap">
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Definition</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Attempt</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Trace</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((execution) => (
                    <tr key={execution.id}>
                      <td>
                        <strong>{execution.definitionKey}</strong>
                        <small>{execution.triggerType}</small>
                      </td>
                      <td>
                        <Badge tone={EXECUTION_STATUS_TONE[execution.status] ?? "neutral"}>{execution.status}</Badge>
                      </td>
                      <td>
                        <Badge tone={PRIORITY_TONE[execution.priority] ?? "neutral"}>{execution.priority}</Badge>
                      </td>
                      <td>{execution.attemptCount}</td>
                      <td>{dateLabel(execution.startedAt)}</td>
                      <td>{durationLabel(execution.durationMs)}</td>
                      <td>
                        {execution.traceId ? (
                          <a className="dashboard-table__link" href={`/execution-history/${execution.traceId}`}>
                            {execution.traceId.slice(0, 12)}…
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="scheduler-actions">
                        {execution.status === "FAILED" || execution.status === "DEAD_LETTERED" || execution.status === "TIMEOUT" ? (
                          <Button variant="secondary" onClick={() => retryMutation.mutate(execution.id)}>
                            Retry
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {executions.length === 0 ? (
                    <tr>
                      <td colSpan={8}>No executions yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </AccessGate>
      ) : null}

      {tab === "templates" ? (
        <AccessGate permission="scheduler.template.read">
          <div className="scheduler-template-grid">
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} onInstantiate={(id) => instantiateMutation.mutate({ templateId: id })} busy={instantiateMutation.isPending} />
            ))}
          </div>
        </AccessGate>
      ) : null}
    </div>
  );
}

function OverviewTab({
  worker,
  recent,
  upcoming
}: {
  worker: WorkerHealth | undefined;
  recent: SchedulerExecution[];
  upcoming: Array<{ id: string; definitionKey: string; nextRun: string; priority: string }>;
}) {
  return (
    <div className="scheduler-overview-grid">
      <Card className="scheduler-card">
        <h3 className="scheduler-card__title">Worker Health</h3>
        {worker ? (
          <dl className="scheduler-dl">
            <dt>Worker</dt>
            <dd>{worker.workerId}</dd>
            <dt>Status</dt>
            <dd>
              <Badge tone={worker.status === "RUNNING" ? "success" : worker.status === "STALE" ? "danger" : "warning"}>{worker.status}</Badge>
            </dd>
            <dt>Last Poll</dt>
            <dd>{dateLabel(worker.lastPollAt)}</dd>
            <dt>Running Jobs</dt>
            <dd>{worker.runningJobs}</dd>
            <dt>Completed / Failed</dt>
            <dd>
              {worker.completedJobs} / {worker.failedJobs}
            </dd>
            <dt>Memory</dt>
            <dd>{worker.memoryMb} MB</dd>
            <dt>CPU Time</dt>
            <dd>{worker.cpuTimeMs}ms</dd>
            <dt>Queue Latency</dt>
            <dd>{worker.queueLatencyMs === null ? "—" : `${worker.queueLatencyMs}ms`}</dd>
          </dl>
        ) : (
          <Skeleton className="h-40" />
        )}
      </Card>

      <Card className="scheduler-card">
        <h3 className="scheduler-card__title">Upcoming Jobs</h3>
        <ul className="dashboard-activity-list">
          {upcoming.map((job) => (
            <li key={job.id} className="dashboard-activity-list__row">
              <span className="dashboard-activity-list__label">
                {job.definitionKey} <Badge tone={PRIORITY_TONE[job.priority] ?? "neutral"}>{job.priority}</Badge>
              </span>
              <span className="dashboard-activity-list__time">{dateLabel(job.nextRun)}</span>
            </li>
          ))}
          {upcoming.length === 0 ? <li className="dashboard-activity-list__row">No upcoming jobs.</li> : null}
        </ul>
      </Card>

      <Card className="scheduler-card scheduler-card--wide">
        <h3 className="scheduler-card__title">Recent Executions</h3>
        <ul className="dashboard-activity-list">
          {recent.map((execution) => (
            <li key={`${execution.definitionKey}-${execution.startedAt}`} className="dashboard-activity-list__row">
              <span className="dashboard-activity-list__label">
                {execution.definitionKey} <Badge tone={EXECUTION_STATUS_TONE[execution.status] ?? "neutral"}>{execution.status}</Badge>
              </span>
              <span className="dashboard-activity-list__time">
                {dateLabel(execution.startedAt)} · {durationLabel(execution.durationMs)}
              </span>
            </li>
          ))}
          {recent.length === 0 ? <li className="dashboard-activity-list__row">No recent executions.</li> : null}
        </ul>
      </Card>
    </div>
  );
}

function TemplateCard({ template, onInstantiate, busy }: { template: JobTemplate; onInstantiate: (id: string) => void; busy: boolean }) {
  return (
    <Card className="scheduler-template-card">
      <Badge tone="neutral">{template.triggerType}</Badge>
      <h4>{template.name}</h4>
      <p>{template.description}</p>
      <dl className="scheduler-dl">
        <dt>Definition</dt>
        <dd>{template.definitionKey}</dd>
        <dt>Trigger</dt>
        <dd>{template.triggerType}</dd>
        <dt>Timezone</dt>
        <dd>{template.timezone}</dd>
      </dl>
      <AccessGate permission="scheduler.template.write">
        <Button onClick={() => onInstantiate(template.id)} disabled={busy}>
          Instantiate
        </Button>
      </AccessGate>
    </Card>
  );
}
