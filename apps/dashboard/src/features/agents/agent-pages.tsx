"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button, Card, EmptyState, Input, Skeleton } from "../../components/ui";
import { createAgentApi, type AgentEmployee } from "./agent-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createAgentApi(client), [client]);
}
export function EmployeesPage() {
  const api = useApi(),
    search = useSearchParams(),
    qc = useQueryClient();
  const q = useQuery({ queryKey: ["agents"], queryFn: api.employees });
  const [selected, setSelected] = useState<AgentEmployee | null>(null),
    [conversationId, setConversationId] = useState<string | undefined>(),
    [messages, setMessages] = useState<
      Array<{ role: "USER" | "ASSISTANT"; content: string; executionId?: string }>
    >([]);
  const requested = search.get("plugin");
  const employee = selected ?? q.data?.find((item) => item.id === requested) ?? null;
  const run = useMutation({
    mutationFn: api.run,
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setMessages((current) => [
        ...current,
        { role: "ASSISTANT", content: result.response, executionId: result.executionId }
      ]);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["executions"] });
    }
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee || run.isPending) return;
    const form = event.currentTarget,
      message = String(new FormData(form).get("message") ?? "").trim();
    if (!message) return;
    setMessages((current) => [...current, { role: "USER", content: message }]);
    run.mutate({
      pluginInstallationId: employee.id,
      ...(conversationId ? { conversationId } : {}),
      message
    });
    form.reset();
  };
  return (
    <AccessGate permission="agents.run">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>AI Employees</h1>
            <p>Run enabled plugin installations through the controlled agent runtime.</p>
          </div>
        </header>
        {q.isLoading ? (
          <Skeleton />
        ) : q.isError ? (
          <Alert tone="danger" title="Unable to load AI employees" />
        ) : q.data?.length ? (
          <div className="admin-grid">
            {q.data.map((item) => (
              <Card key={item.id}>
                <h2>{item.displayName}</h2>
                <p>{item.description}</p>
                <Badge>{item.version}</Badge> <Badge tone="success">{item.status}</Badge>{" "}
                <Badge>{item.lastHealthStatus ?? "UNKNOWN"}</Badge>
                <Badge tone={item.runtimeReady ? "success" : "warning"}>
                  {item.runtimeReady ? "Runtime ready" : "Grant MEMORY to enable memory tools"}
                </Badge>
                <Button onClick={() => setSelected(item)} aria-label={`Run ${item.displayName}`}>
                  Run
                </Button>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No enabled AI employees"
            description="Enable an installed plugin before running it."
          />
        )}
        {employee ? (
          <Card>
            <h2>Chat with {employee.displayName}</h2>
            <div aria-live="polite">
              {messages.map((message, index) => (
                <article key={`${message.role}-${index}`}>
                  <strong>{message.role === "USER" ? "You" : employee.displayName}</strong>
                  <p>{message.content}</p>
                  {message.executionId ? (
                    <Link href={`/execution-history/${message.executionId}`}>View execution</Link>
                  ) : null}
                </article>
              ))}
            </div>
            {run.isError ? (
              <Alert tone="danger" title="Agent execution failed">
                The request could not be completed safely.
              </Alert>
            ) : null}
            <form onSubmit={submit} className="admin-form">
              <label htmlFor="agent-message">Message</label>
              <Input
                id="agent-message"
                name="message"
                required
                maxLength={12000}
                placeholder="Plan a 5-day Dubai trip and remember that I prefer vegetarian food."
              />
              <Button loading={run.isPending} disabled={run.isPending}>
                Send
              </Button>
            </form>
          </Card>
        ) : null}
      </section>
    </AccessGate>
  );
}
export function ConversationsPage() {
  const api = useApi(),
    q = useQuery({ queryKey: ["conversations"], queryFn: () => api.conversations() });
  return (
    <AccessGate permission="agents.conversations.read">
      <section className="admin-page">
        <h1>Conversations</h1>
        <p>Review organization-scoped AI employee conversations.</p>
        {q.isLoading ? (
          <Skeleton />
        ) : q.isError ? (
          <Alert tone="danger" title="Unable to load conversations" />
        ) : q.data?.items.length ? (
          <Card>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>AI employee</th>
                  <th>Creator</th>
                  <th>Messages</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/conversations/${item.id}`}>{item.title}</Link>
                    </td>
                    <td>{item.pluginInstallation.displayName}</td>
                    <td>
                      {item.createdBy.firstName} {item.createdBy.lastName}
                    </td>
                    <td>{item._count.messages}</td>
                    <td>
                      <Badge>{item.status}</Badge>
                    </td>
                    <td>{new Date(item.updatedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <EmptyState
            title="No conversations"
            description="Run an AI employee to begin a conversation."
          />
        )}
      </section>
    </AccessGate>
  );
}
export function ConversationDetail({ id }: { id: string }) {
  const api = useApi(),
    detail = useQuery({ queryKey: ["conversations", id], queryFn: () => api.conversation(id) }),
    messages = useQuery({
      queryKey: ["conversations", id, "messages"],
      queryFn: () => api.messages(id)
    });
  return (
    <AccessGate permission="agents.conversations.read">
      <section className="admin-page">
        {detail.isLoading || messages.isLoading ? (
          <Skeleton />
        ) : detail.isError || messages.isError ? (
          <Alert tone="danger" title="Unable to load conversation" />
        ) : (
          <>
            <h1>{detail.data?.title}</h1>
            <p>{detail.data?.pluginInstallation.displayName}</p>
            {messages.data?.map((message) => (
              <Card key={message.id}>
                <Badge>{message.role}</Badge>
                <p>{message.content}</p>
                {message.role === "TOOL" ? <small>Controlled tool activity</small> : null}
              </Card>
            ))}
          </>
        )}
      </section>
    </AccessGate>
  );
}
export function ExecutionsPage() {
  const api = useApi(),
    q = useQuery({ queryKey: ["executions"], queryFn: () => api.executions() });
  return (
    <AccessGate permission="agents.executions.read">
      <section className="admin-page">
        <h1>Execution History</h1>
        <p>Model usage, tool activity, latency, and safe errors.</p>
        {q.isLoading ? (
          <Skeleton />
        ) : q.isError ? (
          <Alert tone="danger" title="Unable to load executions" />
        ) : q.data?.items.length ? (
          <Card>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>AI employee</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Tokens</th>
                  <th>Tools</th>
                  <th>Latency</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/execution-history/${item.id}`}>{item.id.slice(0, 8)}</Link>
                    </td>
                    <td>{item.pluginInstallation.displayName}</td>
                    <td>
                      <Badge>{item.status}</Badge>
                    </td>
                    <td>{item.model ?? "—"}</td>
                    <td>{item.totalTokens}</td>
                    <td>{item._count?.toolExecutions ?? 0}</td>
                    <td>{item.latencyMs ?? "—"} ms</td>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <EmptyState title="No executions" description="Agent runs will appear here." />
        )}
      </section>
    </AccessGate>
  );
}
export function ExecutionDetail({ id }: { id: string }) {
  const api = useApi(),
    q = useQuery({ queryKey: ["executions", id], queryFn: () => api.execution(id) });
  return (
    <AccessGate permission="agents.executions.read">
      <section className="admin-page">
        {q.isLoading ? (
          <Skeleton />
        ) : q.isError ? (
          <Alert tone="danger" title="Unable to load execution" />
        ) : q.data ? (
          <>
            <h1>Execution {q.data.id.slice(0, 8)}</h1>
            <Card>
              <Badge>{q.data.status}</Badge>
              <p>Provider: {q.data.modelProvider}</p>
              <p>Model: {q.data.model}</p>
              <p>Tokens: {q.data.totalTokens}</p>
              <p>Latency: {q.data.latencyMs ?? "—"} ms</p>
              <Link href={`/conversations/${q.data.conversationId}`}>Open conversation</Link>
            </Card>
            <h2>Tool activity</h2>
            {q.data.toolExecutions?.length ? (
              q.data.toolExecutions.map((tool) => (
                <Card key={tool.id}>
                  <strong>{tool.toolName}</strong> <Badge>{tool.status}</Badge>
                  <p>{tool.latencyMs ?? "—"} ms</p>
                </Card>
              ))
            ) : (
              <p>No tools were used.</p>
            )}
            {q.data.errorCode ? (
              <Alert tone="danger" title={q.data.errorCode}>
                {q.data.errorMessage ?? "Execution failed safely."}
              </Alert>
            ) : null}
          </>
        ) : null}
      </section>
    </AccessGate>
  );
}
