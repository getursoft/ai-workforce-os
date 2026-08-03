"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { AccessGate } from "../admin/authorization";
import { Alert, Badge, Button, Card, Dialog, PageHeader, Skeleton } from "../../components/ui";
import { createWorkforceApi, type DelegatedTask, type WorkforceEmployee } from "./workforce-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createWorkforceApi(client), [client]);
}

const TASK_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  COMPLETED: "success",
  RUNNING: "warning",
  QUEUED: "neutral",
  CREATED: "neutral",
  WAITING_FOR_APPROVAL: "warning",
  WAITING_FOR_INPUT: "warning",
  FAILED: "danger",
  TIMED_OUT: "danger",
  CANCELLED: "neutral",
  REJECTED: "danger"
};

function durationLabel(task: DelegatedTask): string {
  if (!task.startedAt) return "—";
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const ms = end - new Date(task.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function employeeName(employees: WorkforceEmployee[], installationId: string): string {
  return employees.find((employee) => employee.installationId === installationId)?.displayName ?? installationId.slice(0, 8);
}

export function WorkforcePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [selectedTask, setSelectedTask] = useState<DelegatedTask | null>(null);

  const employeesQuery = useQuery({ queryKey: ["workforce", "employees"], queryFn: api.listEmployees });
  const tasksQuery = useQuery({
    queryKey: ["workforce", "tasks"],
    queryFn: () => api.listTasks(),
    refetchInterval: 5000
  });
  const timelineQuery = useQuery({
    queryKey: ["workforce", "task-timeline", selectedTask?.id],
    queryFn: () => api.getTaskTimeline(selectedTask?.id ?? ""),
    enabled: Boolean(selectedTask)
  });

  const employees = employeesQuery.data ?? [];
  const tasks = tasksQuery.data ?? [];
  const activeEmployees = employees.filter((e) => e.status === "ACTIVE");
  const running = tasks.filter((t) => t.status === "RUNNING" || t.status === "QUEUED");
  const waiting = tasks.filter((t) => t.status === "WAITING_FOR_APPROVAL" || t.status === "WAITING_FOR_INPUT");
  const failed = tasks.filter((t) => t.status === "FAILED" || t.status === "TIMED_OUT");
  const completed = tasks.filter((t) => t.status === "COMPLETED" && t.startedAt && t.completedAt);
  const avgCompletionMs =
    completed.length > 0
      ? Math.round(
          completed.reduce((sum, t) => sum + (new Date(t.completedAt as string).getTime() - new Date(t.startedAt as string).getTime()), 0) /
            completed.length
        )
      : null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["workforce"] });

  return (
    <AccessGate permission="workforce.read">
      <section className="admin-page">
        <PageHeader
          eyebrow="Collaboration"
          title="AI Workforce"
          description="Installed AI Employees and the tasks they delegate to each other."
        />

        <section className="dashboard-grid dashboard-grid--summary" aria-label="Summary">
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Installed employees</p>
            <p className="dashboard-stat-card__value">{employees.length}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Active employees</p>
            <p className="dashboard-stat-card__value">{activeEmployees.length}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Running tasks</p>
            <p className="dashboard-stat-card__value">{running.length}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Waiting tasks</p>
            <p className="dashboard-stat-card__value">{waiting.length}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Failed tasks</p>
            <p className="dashboard-stat-card__value">{failed.length}</p>
          </Card>
          <Card className="dashboard-stat-card">
            <p className="dashboard-stat-card__label">Avg completion</p>
            <p className="dashboard-stat-card__value">{avgCompletionMs === null ? "—" : `${(avgCompletionMs / 1000).toFixed(1)}s`}</p>
          </Card>
        </section>

        <h2>Employees</h2>
        {employeesQuery.isLoading ? (
          <Skeleton />
        ) : employees.length === 0 ? (
          <p className="dashboard-home__muted">No AI Employees are installed in this organization.</p>
        ) : (
          <div className="admin-grid">
            {employees.map((employee) => {
              const employeeTasks = tasks.filter(
                (t) => t.sourceEmployeeInstallationId === employee.installationId || t.targetEmployeeInstallationId === employee.installationId
              );
              const currentTaskCount = employeeTasks.filter((t) => t.status === "RUNNING" || t.status === "QUEUED").length;
              const completedTaskCount = employeeTasks.filter((t) => t.status === "COMPLETED").length;
              return (
                <div key={employee.installationId} className="admin-grid-card">
                  <div>
                    <strong>{employee.displayName}</strong>
                    <p>{employee.employeeType ?? "General"} — {employee.routingDomains.join(", ") || "No declared domain"}</p>
                    <div className="flex items-center gap-2" style={{ flexWrap: "wrap", marginTop: 4 }}>
                      {employee.capabilities.map((capability) => (
                        <Badge key={capability}>{capability}</Badge>
                      ))}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <Badge tone={employee.status === "ACTIVE" ? "success" : "neutral"}>{employee.status}</Badge>
                    <p style={{ fontSize: "0.8rem", marginTop: 4 }}>
                      {currentTaskCount} running · {completedTaskCount} completed
                    </p>
                    <Badge tone={employee.collaboration.enabled ? "success" : "neutral"}>
                      {employee.collaboration.enabled ? "Collaboration on" : "Collaboration off"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="admin-section-header">
          <h2>Delegated tasks</h2>
          <Button variant="ghost" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {tasksQuery.isLoading ? (
          <Skeleton />
        ) : tasks.length === 0 ? (
          <p className="dashboard-home__muted">No AI Employee has delegated a task yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Task type</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Created</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id} onClick={() => setSelectedTask(task)} style={{ cursor: "pointer" }}>
                    <td>{employeeName(employees, task.sourceEmployeeInstallationId)}</td>
                    <td>{employeeName(employees, task.targetEmployeeInstallationId)}</td>
                    <td>{task.taskType}</td>
                    <td>
                      <Badge tone={TASK_STATUS_TONE[task.status] ?? "neutral"}>{task.status}</Badge>
                    </td>
                    <td>{durationLabel(task)}</td>
                    <td>{new Date(task.createdAt).toLocaleString()}</td>
                    <td>{task.resultSummary ? "Available" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedTask ? (
        <Dialog
          open
          onCancel={() => setSelectedTask(null)}
          onConfirm={() => setSelectedTask(null)}
          title={selectedTask.title}
          confirmLabel="Close"
          showActions
        >
          <dl>
            <dt>Task type</dt>
            <dd>{selectedTask.taskType}</dd>
            <dt>From</dt>
            <dd>{employeeName(employees, selectedTask.sourceEmployeeInstallationId)}</dd>
            <dt>To</dt>
            <dd>{employeeName(employees, selectedTask.targetEmployeeInstallationId)}</dd>
            <dt>Status</dt>
            <dd>
              <Badge tone={TASK_STATUS_TONE[selectedTask.status] ?? "neutral"}>{selectedTask.status}</Badge>
            </dd>
            <dt>Delegation depth</dt>
            <dd>{selectedTask.delegationDepth}</dd>
            <dt>Attempts</dt>
            <dd>
              {selectedTask.attemptCount} / {selectedTask.maxAttempts}
            </dd>
            <dt>Correlation ID</dt>
            <dd>{selectedTask.correlationId}</dd>
            {selectedTask.resultSummary ? (
              <>
                <dt>Result</dt>
                <dd>{selectedTask.resultSummary}</dd>
              </>
            ) : null}
            {selectedTask.errorCode ? (
              <>
                <dt>Error</dt>
                <dd>
                  {selectedTask.errorCode}: {selectedTask.errorMessageSafe}
                </dd>
              </>
            ) : null}
          </dl>
          {timelineQuery.data ? (
            <>
              <h3>Timeline</h3>
              <ul className="dashboard-activity-list">
                {timelineQuery.data.events.map((event) => (
                  <li key={event.step} className="dashboard-activity-list__row">
                    <span className="dashboard-activity-list__label">{event.step}</span>
                    <span className="dashboard-activity-list__time">{event.at ? new Date(event.at).toLocaleString() : ""}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {selectedTask.status === "FAILED" || selectedTask.status === "TIMED_OUT" ? (
            <Button
              onClick={async () => {
                await api.retryTask(selectedTask.id);
                setSelectedTask(null);
                await refresh();
              }}
            >
              Retry
            </Button>
          ) : null}
          {selectedTask.status === "RUNNING" || selectedTask.status === "QUEUED" || selectedTask.status === "WAITING_FOR_APPROVAL" ? (
            <Button
              variant="danger"
              onClick={async () => {
                await api.cancelTask(selectedTask.id);
                setSelectedTask(null);
                await refresh();
              }}
            >
              Cancel
            </Button>
          ) : null}
        </Dialog>
      ) : null}

      {tasksQuery.isError ? (
        <Alert tone="danger" title="Unable to load delegated tasks">
          <Button onClick={() => tasksQuery.refetch()}>Retry</Button>
        </Alert>
      ) : null}
    </AccessGate>
  );
}
