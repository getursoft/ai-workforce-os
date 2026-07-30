"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button, Card, EmptyState, Input, Skeleton } from "../../components/ui";
import { ApiError } from "../../lib/api-error";
import { createAgentApi, type AgentEmployee, type ConversationMessage } from "./agent-api";
import { createPluginApi } from "../plugins/plugin-api";
import { createTravelApi, TRAVEL_EMPLOYEE_PLUGIN_ID, type TravelStage } from "../travel/travel-api";
import { parseTravelRecommendation, type ParsedItinerary } from "./itinerary";

export interface ChatMessage {
  role: "USER" | "ASSISTANT";
  content: string;
  executionId?: string;
  sources?: Array<{
    documentId: string;
    title: string;
    pageNumber: number | null;
    chunkIndex: number;
    score: number;
  }>;
}

/** sessionStorage key that remembers the *last* conversation id for one AI employee, purely so the UI
 * can offer to resume it. Its presence must never, by itself, cause a conversation to be resumed — that
 * silently reused customer context (name, trip state) across what a user believed was a brand-new
 * conversation. Resuming only ever happens via the user's explicit choice; see `decideConversationEntry`. */
export function conversationStorageKey(pluginInstallationId: string): string {
  return `agent-conversation:${pluginInstallationId}`;
}

/** What the chat UI should do when an employee is opened: greet fresh immediately (nothing was stored,
 * so there is nothing to offer resuming), or ask the user to explicitly choose between resuming the
 * last conversation and starting a new one. Pure and unit-testable independent of sessionStorage/React. */
export type ConversationEntryDecision =
  | { action: "GREET_NEW" }
  | { action: "ASK_RESUME_OR_NEW"; storedConversationId: string };

export function decideConversationEntry(storedConversationId: string | null): ConversationEntryDecision {
  return storedConversationId
    ? { action: "ASK_RESUME_OR_NEW", storedConversationId }
    : { action: "GREET_NEW" };
}

/** Converts persisted conversation rows to local chat bubbles — drops anything that isn't an actual
 * user/assistant turn, and any row with empty content, so a synthetic/empty turn is never rendered. */
export function toLocalMessages(rows: ConversationMessage[]): ChatMessage[] {
  return rows
    .filter(
      (row): row is ConversationMessage & { role: "USER" | "ASSISTANT" } =>
        (row.role === "USER" || row.role === "ASSISTANT") && row.content.trim().length > 0
    )
    .map((row) => ({ role: row.role, content: row.content }));
}

/** Context-aware input placeholder for the Travel Employee, driven by its onboarding/collection stage and
 * by whether the most recent reply was a knowledge-grounded answer (see `hasKnowledgeSources` below) —
 * a traveler mid-policy-question sees a question-oriented placeholder regardless of their trip-planning
 * stage underneath, since a knowledge question can come up at any point in the conversation. */
export function derivePlaceholder(
  stage: TravelStage | null | undefined,
  hasKnowledgeSources = false
): string {
  if (!stage || stage === "GREETING" || stage === "COLLECT_NAME") return "Type your name...";
  if (stage === "DISCOVER_INTENT") return "How can I help you with your travel?";
  if (hasKnowledgeSources) return "Ask your travel question...";
  if (stage === "COLLECT_DESTINATION") return "Tell me where you'd like to travel...";
  return "Tell me more about your trip...";
}

const DEFAULT_PLACEHOLDER = "Plan a 5-day Dubai trip and remember that I prefer vegetarian food.";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createAgentApi(client), [client]);
}
function usePluginApi() {
  const { client } = useAuth();
  return useMemo(() => createPluginApi(client), [client]);
}
function useTravelApi() {
  const { client } = useAuth();
  return useMemo(() => createTravelApi(client), [client]);
}
export function EmployeesPage() {
  const api = useApi(),
    plugins = usePluginApi(),
    travel = useTravelApi(),
    search = useSearchParams(),
    qc = useQueryClient();
  const q = useQuery({ queryKey: ["agents"], queryFn: api.employees });
  const available = useQuery({ queryKey: ["agents", "available"], queryFn: plugins.available });
  const uninstalled = available.data?.items.filter((item) => !item.installed) ?? [];
  const install = useMutation({
    mutationFn: (pluginId: string) => {
      const manifest = available.data?.items.find((item) => item.id === pluginId);
      return plugins.install({
        pluginId,
        grantedPermissions: manifest?.permissions ?? [],
        enable: true,
        configuration: { config: {}, secrets: {} }
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
    }
  });
  const [selected, setSelected] = useState<AgentEmployee | null>(null),
    [conversationId, setConversationId] = useState<string | undefined>(),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    // Set only while the user has an unresolved "resume or start new?" choice for a stored conversation —
    // never auto-resumed. Cleared as soon as either choice is made.
    [resumeChoice, setResumeChoice] = useState<string | null>(null);
  const requested = search.get("plugin");
  const employee = selected ?? q.data?.find((item) => item.id === requested) ?? null;
  const run = useMutation({
    mutationFn: api.run,
    onSuccess: (result, variables) => {
      if (!result || typeof result !== "object") return;
      const r = result as unknown as Record<string, unknown>;
      const convId = typeof r.conversationId === "string" ? r.conversationId : "";
      const resp = typeof r.response === "string" ? r.response : "";
      const execId = typeof r.executionId === "string" ? r.executionId : "";
      const sources = Array.isArray(r.sources) ? r.sources : [];
      setConversationId(convId);
      if (resp) {
        setMessages((current) => [...current, { role: "ASSISTANT", content: resp, executionId: execId, sources }]);
      }
      if (convId) {
        sessionStorage.setItem(conversationStorageKey(variables.pluginInstallationId), convId);
      }
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["executions"] });
      void qc.invalidateQueries({ queryKey: ["travel-state"] });
    }
  });
  // Starts a brand-new conversation: clears any stored conversation id for this employee first, so a
  // customer identity resolved for the old conversation can never leak into this one via sessionStorage,
  // then resets local chat state and fires the proactive greeting. Independent of `resumeConversation` —
  // callable on its own from the mount effect or from the resume/new-conversation choice below.
  const startNewConversation = (pluginInstallationId: string) => {
    sessionStorage.removeItem(conversationStorageKey(pluginInstallationId));
    setResumeChoice(null);
    setMessages([]);
    setConversationId(undefined);
    run.mutate({ pluginInstallationId, message: "" });
  };
  // Explicitly resumes a specific prior conversation — only ever called from the user's own choice (the
  // resume/new-conversation prompt), never automatically on mount/refresh.
  const resumeConversation = (pluginInstallationId: string, id: string) => {
    setResumeChoice(null);
    setConversationId(id);
    void api
      .messages(id)
      .then((rows) => setMessages(toLocalMessages(rows)))
      .catch(() => {
        // The stored conversation no longer resolves (e.g. deleted) — start fresh instead of leaving the
        // chat silently empty.
        setConversationId(undefined);
        startNewConversation(pluginInstallationId);
      });
  };
  // Idempotency guard for entering an employee's chat: a ref (not state) so it survives React StrictMode's
  // deliberate double-invoke of effects in dev without re-evaluating twice, keyed per employee id so
  // switching employees (or coming back to one already handled) re-evaluates correctly.
  const handledEmployeeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!employee) return;
    if (handledEmployeeRef.current === employee.id) return;
    handledEmployeeRef.current = employee.id;
    setMessages([]);
    setConversationId(undefined);
    setResumeChoice(null);
    // Only the Travel Employee proactively greets — every other AI employee keeps starting blank until
    // the traveler/user sends the first message, unchanged from before.
    if (employee.slug !== TRAVEL_EMPLOYEE_PLUGIN_ID) return;
    const decision = decideConversationEntry(sessionStorage.getItem(conversationStorageKey(employee.id)));
    // A stored conversation id is never auto-resumed: resuming silently reuses whatever customer context
    // (name, trip state) that conversation had, which is exactly the isolation bug this guards against.
    // The user must explicitly choose — see the resume/new-conversation prompt in the render below.
    if (decision.action === "ASK_RESUME_OR_NEW") {
      setResumeChoice(decision.storedConversationId);
      return;
    }
    startNewConversation(employee.id);
    // `run`/`api` intentionally excluded: only the employee identity should re-trigger this effect.
  }, [employee?.id]);
  const travelStateQuery = useQuery({
    queryKey: ["travel-state", employee?.id, conversationId],
    queryFn: () => travel.state(employee?.id ?? "", conversationId ?? ""),
    enabled: Boolean(employee?.slug === TRAVEL_EMPLOYEE_PLUGIN_ID && conversationId),
    retry: false
  });
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === "ASSISTANT");
  const placeholder =
    employee?.slug === TRAVEL_EMPLOYEE_PLUGIN_ID
      ? derivePlaceholder(travelStateQuery.data?.stage, Boolean(lastAssistantMessage?.sources?.length))
      : DEFAULT_PLACEHOLDER;
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
                {item.slug === "travel-employee" ? (
                  <Link href={`/travel-employee`} aria-label={`Configure ${item.displayName}`}>
                    Configure
                  </Link>
                ) : null}
              </Card>
            ))}
          </div>
        ) : !uninstalled.length ? (
          <EmptyState
            title="No enabled AI employees"
            description="Create your first AI Employee by installing one below, then enable it."
          />
        ) : null}
        {uninstalled.length ? (
          <Card>
            <h2>Available AI Employees</h2>
            <p>Install a built-in AI employee to get started.</p>
            <div className="admin-grid">
              {uninstalled.map((manifest) => (
                <Card key={manifest.id}>
                  <h3>{manifest.displayName}</h3>
                  <p>{manifest.description}</p>
                  <Badge>{manifest.version}</Badge>
                  <Can permission="plugin.install">
                    <Button
                      loading={install.isPending && install.variables === manifest.id}
                      disabled={install.isPending}
                      onClick={() => install.mutate(manifest.id)}
                      aria-label={`Install ${manifest.displayName}`}
                    >
                      Install
                    </Button>
                  </Can>
                </Card>
              ))}
            </div>
            {install.isError ? (
              <Alert tone="danger" title="Installation failed">
                {agentRunErrorMessage(install.error)}
              </Alert>
            ) : null}
          </Card>
        ) : null}
        {employee && resumeChoice ? (
          <Card>
            <h2>Chat with {employee.displayName}</h2>
            <p>You have a previous conversation with {employee.displayName}. Resume it, or start fresh?</p>
            <Button onClick={() => resumeConversation(employee.id, resumeChoice)}>
              Resume previous conversation
            </Button>{" "}
            <Button onClick={() => startNewConversation(employee.id)}>Start new conversation</Button>
          </Card>
        ) : null}
        {employee && !resumeChoice ? (
          <Card>
            <h2>Chat with {employee.displayName}</h2>
            <div className="chat-thread" aria-live="polite">
              {messages
                .filter((message) => message.content?.trim()?.length > 0)
                .map((message, index) => {
                  const isUser = message.role === "USER";
                  const itinerary = isUser ? null : parseTravelRecommendation(message.content);
                  return (
                    <article
                      key={`${message.role}-${index}`}
                      className={`chat-bubble chat-bubble--${isUser ? "user" : "assistant"}`}
                    >
                      <span className="chat-bubble__author">{isUser ? "You" : employee.displayName}</span>
                      {itinerary ? (
                        <TravelItineraryCards itinerary={itinerary} />
                      ) : (
                        <p className="chat-bubble__text">{message.content}</p>
                      )}
                      {message.sources?.length ? (
                        <details className="chat-sources" aria-label="Sources">
                          <summary>Sources</summary>
                          <ul>
                            {message.sources.map((source) => (
                              <li key={`${source.documentId}-${source.chunkIndex}`}>
                                {knowledgeSourceLabel(source)}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                      {message.executionId ? (
                        <details className="chat-debug">
                          <summary>Debug</summary>
                          <div>
                            <Link href={`/execution-history/${message.executionId}`}>View execution</Link>
                          </div>
                        </details>
                      ) : null}
                    </article>
                  );
                })}
            </div>
            {run.isError ? (
              <Alert tone="danger" title="Agent execution failed">
                {agentRunErrorMessage(run.error)}
              </Alert>
            ) : null}
            <form onSubmit={submit} className="admin-form">
              <label htmlFor="agent-message">Message</label>
              <Input id="agent-message" name="message" required maxLength={12000} placeholder={placeholder} />
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

function TravelItineraryCards({ itinerary }: { itinerary: ParsedItinerary }) {
  return (
    <div className="itinerary">
      {itinerary.intro ? <p className="itinerary__intro">{itinerary.intro}</p> : null}
      <div className="itinerary-grid">
        {itinerary.flights.length ? (
          <Card className="itinerary-card">
            <h4>Flights</h4>
            <ul>
              {itinerary.flights.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        ) : null}
        {itinerary.hotels.length ? (
          <Card className="itinerary-card">
            <h4>Hotels</h4>
            <ul>
              {itinerary.hotels.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
      {itinerary.itineraryDays.length ? (
        <Card className="itinerary-card itinerary-card--days">
          <h4>Day-by-day</h4>
          <ul>
            {itinerary.itineraryDays.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
      ) : null}
      {itinerary.footer.map((line) => (
        <p key={line} className="itinerary-footer">
          {line}
        </p>
      ))}
    </div>
  );
}

export function agentRunErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "The request could not be completed safely.";
  const messages: Record<string, string> = {
    AI_PROVIDER_AUTHENTICATION_FAILED: "The configured AI provider credentials were rejected.",
    AI_PROVIDER_MODEL_NOT_FOUND: "The configured AI model is unavailable.",
    AI_PROVIDER_QUOTA_EXCEEDED: "The AI provider quota has been exceeded.",
    AI_PROVIDER_UNAVAILABLE: "The AI provider is currently unavailable.",
    AI_PROVIDER_TEST_FAILED: "The AI provider could not complete the request.",
    AI_PROVIDER_RESPONSE_INVALID: "The AI provider returned an invalid response.",
    AGENT_EXECUTION_FAILED: "The agent execution could not be completed safely."
  };
  return messages[error.code] ?? "The request could not be completed safely.";
}
export function knowledgeSourceLabel(source: {
  title: string;
  pageNumber: number | null;
  chunkIndex: number;
  score: number;
}): string {
  return `${source.title} — ${
    source.pageNumber ? `page ${source.pageNumber}` : `chunk ${source.chunkIndex + 1}`
  } (${Math.round(source.score * 100)}% relevance)`;
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
