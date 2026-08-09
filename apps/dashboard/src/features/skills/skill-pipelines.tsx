"use client";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Can } from "../admin/authorization";
import { Alert, Badge, Button, Card, Dialog, EmptyState, Input, Label, Skeleton } from "../../components/ui";
import { useApi, useAgentApi, queryKey, statusTone } from "./skill-pages";
import type { SkillPipelineExecutionWithNodes, SkillPipelineNodeFailureMode, SkillPipelineWithNodes } from "./skill-api";

interface NodeRow {
  order: number;
  skillKey: string;
  onFailure: SkillPipelineNodeFailureMode;
  conditionExpression: string;
}

function nodeBorderColor(status: string): string {
  if (status === "COMPLETED") return "var(--success, #2f9e57)";
  if (status === "FAILED") return "var(--danger, #d33)";
  if (status === "RUNNING") return "var(--warning, #d9a441)";
  if (status === "SKIPPED") return "var(--muted, #999)";
  return "var(--border)";
}

/** Sprint 6.1B Feature 1/7 — Pipelines tab: create/list reusable skill chains, execute them, and
 *  inspect the execution graph (DAG) of any past run as an ordered flow of node cards. */
export function PipelinesTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillPipelineWithNodes | null>(null);

  const pipelines = useQuery({ queryKey: [...queryKey, "pipelines"], queryFn: api.listPipelines });
  const marketplace = useQuery({ queryKey: [...queryKey, "marketplace"], queryFn: api.marketplace });

  const refresh = () => qc.invalidateQueries({ queryKey: [...queryKey, "pipelines"] });

  const remove = useMutation({
    mutationFn: (pipelineId: string) => api.deletePipeline(pipelineId),
    onSuccess: (_data, pipelineId) => {
      setDeleteTarget(null);
      if (selectedPipelineId === pipelineId) setSelectedPipelineId(null);
      refresh();
    }
  });

  const installedKeys = (marketplace.data?.items ?? []).filter((item) => item.installed).map((item) => item.key);
  const skillKeyOptions = installedKeys.length > 0 ? installedKeys : (marketplace.data?.items ?? []).map((item) => item.key);

  if (pipelines.isLoading) return <Skeleton />;
  if (pipelines.isError)
    return (
      <Alert tone="danger" title="Unable to load pipelines">
        <Button onClick={() => pipelines.refetch()}>Retry</Button>
      </Alert>
    );

  return (
    <>
      <div className="admin-actions">
        <Can permission="skill.install">
          <Button onClick={() => setCreateOpen(true)}>Create Pipeline</Button>
        </Can>
      </div>

      {pipelines.data?.length ? (
        <div className="admin-grid" style={{ gridTemplateColumns: "340px 1fr", alignItems: "start" }}>
          <Card>
            <h2>Pipelines</h2>
            <div style={{ display: "grid", gap: 8 }}>
              {pipelines.data.map((item) => (
                <div key={item.id}>
                  <button
                    onClick={() => setSelectedPipelineId(item.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      display: "grid",
                      gap: 4,
                      padding: 10,
                      borderRadius: 10,
                      border: `1px solid ${selectedPipelineId === item.id ? "var(--primary)" : "var(--border)"}`,
                      background: selectedPipelineId === item.id ? "var(--primary-soft, rgba(99,102,241,0.08))" : "transparent",
                      cursor: "pointer"
                    }}
                  >
                    <strong>{item.name}</strong>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge>{item.nodes.length} node{item.nodes.length === 1 ? "" : "s"}</Badge>
                      <Badge tone={item.isActive ? "success" : "neutral"}>{item.isActive ? "Active" : "Inactive"}</Badge>
                    </div>
                    <small style={{ color: "var(--muted)" }}>
                      {item._count.executions} execution{item._count.executions === 1 ? "" : "s"}
                    </small>
                  </button>
                  <Can permission="skill.uninstall">
                    <Button variant="ghost" onClick={() => setDeleteTarget(item)}>
                      Delete
                    </Button>
                  </Can>
                </div>
              ))}
            </div>
          </Card>
          {selectedPipelineId ? (
            <PipelineDetail pipelineId={selectedPipelineId} />
          ) : (
            <EmptyState title="Select a pipeline" description="Choose a pipeline from the list to view and execute it." />
          )}
        </div>
      ) : (
        <EmptyState
          title="No pipelines yet"
          description="Create a pipeline to chain skill executions together."
          action={
            <Can permission="skill.install">
              <Button onClick={() => setCreateOpen(true)}>Create Pipeline</Button>
            </Can>
          }
        />
      )}

      <CreatePipelineDialog
        open={createOpen}
        skillKeyOptions={skillKeyOptions}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
      />

      <Dialog
        open={deleteTarget !== null}
        title="Delete this pipeline?"
        description="This soft-deletes the pipeline definition. Past executions remain visible for audit purposes."
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ pipeline detail (executions + DAG)

function PipelineDetail({ pipelineId }: Readonly<{ pipelineId: string }>) {
  const api = useApi();
  const agentApi = useAgentApi();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [executeOpen, setExecuteOpen] = useState(false);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [inputJson, setInputJson] = useState("{}");

  const pipeline = useQuery({ queryKey: [...queryKey, "pipeline", pipelineId], queryFn: () => api.getPipeline(pipelineId) });
  const executions = useQuery({
    queryKey: [...queryKey, "pipeline", pipelineId, "executions", page],
    queryFn: () => api.listPipelineExecutions(pipelineId, page, pageSize)
  });
  const employees = useQuery({ queryKey: ["agents", "employees"], queryFn: agentApi.employees, enabled: executeOpen });

  const execute = useMutation({
    mutationFn: () => {
      let parsedInput: unknown;
      try {
        parsedInput = inputJson.trim() ? JSON.parse(inputJson) : undefined;
      } catch {
        throw new Error("Trigger input must be valid JSON");
      }
      return api.executePipeline(pipelineId, {
        ...(parsedInput !== undefined ? { input: parsedInput } : {}),
        ...(employeeId ? { pluginInstallationId: employeeId } : {})
      });
    },
    onSuccess: (result) => {
      setExecuteOpen(false);
      setSelectedExecutionId(result.id);
      void qc.invalidateQueries({ queryKey: [...queryKey, "pipeline", pipelineId, "executions"] });
      void qc.invalidateQueries({ queryKey: [...queryKey, "pipelines"] });
    }
  });

  const executionDetail = useQuery({
    queryKey: [...queryKey, "pipeline-execution", selectedExecutionId],
    queryFn: () => api.getPipelineExecution(selectedExecutionId as string),
    enabled: selectedExecutionId !== null
  });

  if (pipeline.isLoading) return <Skeleton />;
  if (pipeline.isError)
    return (
      <Alert tone="danger" title="Unable to load pipeline">
        <Button onClick={() => pipeline.refetch()}>Retry</Button>
      </Alert>
    );
  if (!pipeline.data) return null;

  const total = executions.data?.total ?? 0;
  const hasNext = page * pageSize < total;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div className="admin-section-header">
          <div>
            <h2>{pipeline.data.name}</h2>
            <p>{pipeline.data.description}</p>
          </div>
          <Can permission="skill.execute">
            <Button onClick={() => setExecuteOpen(true)}>Execute</Button>
          </Can>
        </div>
        <ol style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          {pipeline.data.nodes.map((node) => (
            <li key={node.id}>
              {node.skillKey}
              {node.versionConstraint ? ` (${node.versionConstraint})` : ""} — <Badge>{node.onFailure}</Badge>
              {node.conditionExpression ? (
                <span className="text-sm" style={{ color: "var(--muted)" }}>
                  {" "}
                  if {node.conditionExpression}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <h2>Executions</h2>
        {executions.isLoading ? (
          <Skeleton />
        ) : executions.isError ? (
          <Alert tone="danger" title="Unable to load executions">
            <Button onClick={() => executions.refetch()}>Retry</Button>
          </Alert>
        ) : executions.data?.items.length ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {executions.data.items.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                      </td>
                      <td>{run.durationMs} ms</td>
                      <td>{new Date(run.startedAt).toLocaleString()}</td>
                      <td>{run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}</td>
                      <td>
                        <Button variant="ghost" onClick={() => setSelectedExecutionId(run.id)}>
                          View graph
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-actions" style={{ marginTop: 12 }}>
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </Button>
              <span>
                Page {page} · {total} total
              </span>
              <Button variant="secondary" disabled={!hasNext} onClick={() => setPage((current) => current + 1)}>
                Next
              </Button>
            </div>
          </>
        ) : (
          <EmptyState title="No executions yet" description="Execute this pipeline to see its run history." />
        )}
      </Card>

      {selectedExecutionId ? (
        <Card>
          <div className="admin-section-header">
            <h2>Execution graph</h2>
            <Button variant="ghost" onClick={() => setSelectedExecutionId(null)}>
              Close
            </Button>
          </div>
          {executionDetail.isLoading ? (
            <Skeleton />
          ) : executionDetail.isError ? (
            <Alert tone="danger" title="Unable to load this execution" />
          ) : executionDetail.data ? (
            <PipelineDagView execution={executionDetail.data} />
          ) : null}
        </Card>
      ) : null}

      <Dialog
        open={executeOpen}
        title={`Execute ${pipeline.data.name}`}
        description="Pick an employee (optional) and provide the trigger input as JSON."
        confirmLabel="Execute"
        onCancel={() => setExecuteOpen(false)}
        onConfirm={() => execute.mutate()}
      >
        <div className="admin-form">
          <Label htmlFor="pipeline-execute-employee">Employee (optional)</Label>
          {employees.isLoading ? (
            <Skeleton />
          ) : (
            <select
              id="pipeline-execute-employee"
              className="ui-input"
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
            >
              <option value="">None</option>
              {(employees.data ?? []).map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.displayName}
                </option>
              ))}
            </select>
          )}
          <Label htmlFor="pipeline-execute-input">Trigger input (JSON)</Label>
          <textarea
            id="pipeline-execute-input"
            className="ui-input"
            rows={6}
            value={inputJson}
            onChange={(event) => setInputJson(event.target.value)}
          />
        </div>
        {execute.isError ? (
          <Alert tone="danger" title="Execution failed">
            {execute.error instanceof Error ? execute.error.message : null}
          </Alert>
        ) : null}
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ DAG view (plain CSS, no chart library)

function PipelineDagView({ execution }: Readonly<{ execution: SkillPipelineExecutionWithNodes }>) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 12 }}>
        <Badge tone={statusTone(execution.status)}>{execution.status}</Badge>
        <Badge>{execution.durationMs} ms total</Badge>
        {execution.traceId ? <Badge>trace {execution.traceId.slice(0, 8)}</Badge> : null}
      </div>
      <div style={{ display: "grid", gap: 4, maxWidth: 480 }}>
        {execution.nodeExecutions.map((node, index) => (
          <Fragment key={node.id}>
            <div
              style={{
                border: "1px solid var(--border)",
                borderLeft: `4px solid ${nodeBorderColor(node.status)}`,
                borderRadius: 10,
                padding: 12
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong>
                  {node.order}. {node.skillKey}
                </strong>
                <Badge tone={statusTone(node.status)}>{node.status}</Badge>
              </div>
              <p className="text-sm" style={{ color: "var(--muted)", margin: "4px 0 0" }}>
                {node.durationMs} ms{node.retryCount ? ` · ${node.retryCount} retries` : ""}
              </p>
              {node.errorMessageSafe ? (
                <p className="text-sm" style={{ color: "var(--danger, #d33)", margin: "4px 0 0" }}>
                  {node.errorCode}: {node.errorMessageSafe}
                </p>
              ) : null}
            </div>
            {index < execution.nodeExecutions.length - 1 ? (
              <div style={{ textAlign: "center", color: "var(--muted)" }} aria-hidden="true">
                ↓
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ create pipeline dialog

function CreatePipelineDialog({
  open,
  skillKeyOptions,
  onClose,
  onCreated
}: Readonly<{ open: boolean; skillKeyOptions: string[]; onClose(): void; onCreated(): void }>) {
  const api = useApi();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<NodeRow[]>([
    { order: 1, skillKey: skillKeyOptions[0] ?? "", onFailure: "STOP", conditionExpression: "" }
  ]);

  const create = useMutation({
    mutationFn: () =>
      api.createPipeline({
        name,
        description,
        nodes: rows.map((row) => ({
          order: row.order,
          skillKey: row.skillKey,
          onFailure: row.onFailure,
          ...(row.conditionExpression.trim() ? { conditionExpression: row.conditionExpression.trim() } : {})
        }))
      }),
    onSuccess: () => {
      setName("");
      setDescription("");
      setRows([{ order: 1, skillKey: skillKeyOptions[0] ?? "", onFailure: "STOP", conditionExpression: "" }]);
      onCreated();
    }
  });

  const updateRow = (index: number, patch: Partial<NodeRow>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      { order: current.length + 1, skillKey: skillKeyOptions[0] ?? "", onFailure: "STOP", conditionExpression: "" }
    ]);
  };

  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
  };

  return (
    <Dialog
      open={open}
      title="Create pipeline"
      description="Chain skill executions into a reusable, ordered pipeline."
      confirmLabel="Create"
      onCancel={onClose}
      onConfirm={() => {
        if (!name.trim() || !description.trim() || rows.length === 0) return;
        create.mutate();
      }}
    >
      <div className="admin-form">
        <Label htmlFor="pipeline-name">Name</Label>
        <Input id="pipeline-name" value={name} onChange={(event) => setName(event.target.value)} />
        <Label htmlFor="pipeline-description">Description</Label>
        <textarea
          id="pipeline-description"
          className="ui-input"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <Label>Nodes</Label>
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((row, index) => (
            <div
              key={index}
              style={{ display: "grid", gridTemplateColumns: "70px 1fr 160px 1fr auto", gap: 8, alignItems: "center" }}
            >
              <input
                type="number"
                className="ui-input"
                min={1}
                value={row.order}
                onChange={(event) => updateRow(index, { order: Number(event.target.value) })}
              />
              <select
                className="ui-input"
                value={row.skillKey}
                onChange={(event) => updateRow(index, { skillKey: event.target.value })}
              >
                {skillKeyOptions.length === 0 ? <option value="">No skills available</option> : null}
                {skillKeyOptions.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <select
                className="ui-input"
                value={row.onFailure}
                onChange={(event) => updateRow(index, { onFailure: event.target.value as SkillPipelineNodeFailureMode })}
              >
                <option value="STOP">Stop on failure</option>
                <option value="CONTINUE">Continue on failure</option>
              </select>
              <input
                className="ui-input"
                placeholder="Condition expression (optional)"
                value={row.conditionExpression}
                onChange={(event) => updateRow(index, { conditionExpression: event.target.value })}
              />
              <Button type="button" variant="ghost" disabled={rows.length <= 1} onClick={() => removeRow(index)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
        <Button type="button" variant="secondary" onClick={addRow}>
          Add node
        </Button>
      </div>
      {create.isError ? (
        <Alert tone="danger" title="Pipeline creation failed">
          {create.error instanceof Error ? create.error.message : null}
        </Alert>
      ) : null}
    </Dialog>
  );
}
