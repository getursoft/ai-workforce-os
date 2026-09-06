"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, FileText, Paperclip, Send, Sparkles, User, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import {
  Alert,
  Badge,
  BackLink,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton
} from "../../components/ui";
import { ApiError } from "../../lib/api-error";
import { createAgentApi, type ConversationMessage, type ReceptionistResult } from "./agent-api";
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
  attachments?: Array<
    | { type: "PDF_TICKET"; bookingId: string; url: string; filename: string }
    | { type: "CONVERSATION_LINK"; employeeInstallationId: string; conversationId: string; label: string }
  >;
  /** Names of files the user attached to this message (displayed in the user bubble). */
  fileAttachments?: string[];
  receptionist?: ReceptionistResult;
}

export function receptionistFrontDoorError(error: unknown): {
  title: string;
  message: string;
  safeCode: string;
  requestId?: string;
} {
  if (!(error instanceof ApiError))
    return {
      title: "Unable to load the workforce front door",
      message: "The AI Receptionist could not be loaded. Please try again.",
      safeCode: "UNKNOWN_ERROR"
    };
  const common = {
    safeCode: error.kind === "network" || error.kind === "timeout" ? "API_UNAVAILABLE" : error.code,
    ...(error.requestId ? { requestId: error.requestId } : {})
  };
  if (error.kind === "authentication")
    return {
      ...common,
      title: "Your session has expired",
      message: "Sign in again to open the AI Receptionist."
    };
  if (error.kind === "authorization")
    return {
      ...common,
      title: "AI Receptionist access is restricted",
      message: "Ask an organization administrator for AI Employee access."
    };
  if (error.kind === "network" || error.kind === "timeout")
    return {
      ...common,
      title: "AI service is unavailable",
      message: "The dashboard could not reach the API. Please retry shortly."
    };
  if (error.status === 404)
    return {
      ...common,
      safeCode: "RECEPTIONIST_ENDPOINT_UNAVAILABLE",
      title: "AI Receptionist service is not available",
      message: "The workforce front-door API is not registered on the running server."
    };
  return {
    ...common,
    title: "Unable to load the workforce front door",
    message:
      "The AI Receptionist could not be loaded safely. Please retry or contact an administrator."
  };
}

/** Maps an installed AI employee's plugin slug to its dedicated dashboard configuration route — every
 *  domain employee (Travel plus the shared-engine HR / Finance / IT / Sales / Marketing / Legal / Customer
 *  Support) gets a Configure link on its employee card. */
export const EMPLOYEE_CONFIGURE_ROUTES: Record<string, string> = {
  "travel-employee": "/travel-employee",
  "hr-employee": "/hr-employee",
  "finance-employee": "/finance-employee",
  "it-support-employee": "/it-support-employee",
  "sales-employee": "/sales-employee",
  "marketing-employee": "/marketing-employee",
  "legal-employee": "/legal-employee",
  "customer-support-employee": "/customer-support-employee"
};

/** Employees whose chat pages render the proactive greeting (an empty message on a brand-new conversation
 *  returns the configured welcome message). Travel plus every shared-engine domain employee. */
export const GREETING_EMPLOYEE_SLUGS: ReadonlySet<string> = new Set([
  TRAVEL_EMPLOYEE_PLUGIN_ID,
  "hr-employee",
  "finance-employee",
  "it-support-employee",
  "sales-employee",
  "marketing-employee",
  "legal-employee",
  "customer-support-employee",
  "receptionist-employee"
]);

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
  { action: "GREET_NEW" } | { action: "ASK_RESUME_OR_NEW"; storedConversationId: string };

export function decideConversationEntry(
  storedConversationId: string | null
): ConversationEntryDecision {
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
    .map((row) => ({
      role: row.role,
      content: row.content,
      ...(row.contentJson?.receptionist ? { receptionist: row.contentJson.receptionist } : {}),
      ...(row.contentJson?.attachments?.length ? { attachments: row.contentJson.attachments } : {})
    }));
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

/** Domain-specific chat placeholders — one per installed AI employee, so the composer hint always matches
 *  the employee being talked to instead of showing the same travel text for everyone. */
export const EMPLOYEE_PLACEHOLDERS: Record<string, string> = {
  "travel-employee": DEFAULT_PLACEHOLDER,
  "hr-employee": "Ask about leave policy, onboarding, benefits, or raise an HR request…",
  "finance-employee": "Ask about expenses, invoices, budgets, or reports…",
  "it-support-employee": "My VPN is not working, or ask about access, password, or hardware…",
  "sales-employee": "Ask about a product, request a quote, or book a demo…",
  "marketing-employee": "Plan a campaign, draft content, or summarise performance…",
  "legal-employee": "Draft a reply to a notice, or ask about a response deadline…",
  "customer-support-employee": "Where is my order, request a refund, or report an issue…",
  "receptionist-employee": "Ask Krevia anything…"
};

export const RECEPTIONIST_PLUGIN_SLUG = "receptionist-employee";

/** Quick-start shortcuts shown on the Receptionist's empty-conversation welcome screen. Each one is
 *  nothing more than a natural customer message sent through the exact same Receptionist endpoint a typed
 *  message would use — the routing engine (deterministic scoring, domain-switch detection, identity
 *  capture) stays fully authoritative and is never bypassed or second-guessed here. */
export const RECEPTIONIST_QUICK_ACTIONS: ReadonlyArray<{ label: string; message: string }> = [
  { label: "Plan a trip", message: "I want to plan a trip." },
  { label: "Apply for leave", message: "I want to apply for leave." },
  { label: "Review a contract", message: "I need help reviewing a contract." },
  { label: "Check an invoice", message: "I need help with an invoice." },
  { label: "IT support", message: "I need help with an IT issue." },
  { label: "Customer support", message: "I need customer support." }
];

/** Resolves the composer placeholder for the currently open employee. Travel stays stage-aware (via its
 *  conversation state); every other employee uses its own domain hint. */
export function employeePlaceholder(
  slug: string,
  travelStage: TravelStage | null | undefined,
  hasKnowledgeSources: boolean,
  hasConversation: boolean
): string {
  if (slug === "travel-employee")
    return hasConversation
      ? derivePlaceholder(travelStage, hasKnowledgeSources)
      : (EMPLOYEE_PLACEHOLDERS["travel-employee"] ?? DEFAULT_PLACEHOLDER);
  return EMPLOYEE_PLACEHOLDERS[slug] ?? "Type your message…";
}

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
    qc = useQueryClient(),
    router = useRouter();
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
          <div className="employee-grid">
            {q.data.map((item) => (
              <div key={item.id} className="employee-card">
                <div className="employee-card__header">
                  <div className="employee-card__icon" aria-hidden="true">
                    <Bot />
                  </div>
                  <div className="employee-card__body">
                    <h2>{item.displayName}</h2>
                    <p>{item.description}</p>
                  </div>
                </div>
                <div className="employee-card__badges">
                  <Badge>{item.version}</Badge>
                  <Badge tone="success">{item.status}</Badge>
                  <Badge>{item.lastHealthStatus ?? "UNKNOWN"}</Badge>
                  <Badge tone={item.runtimeReady ? "success" : "warning"}>
                    {item.runtimeReady ? "Runtime ready" : "Grant MEMORY to enable memory tools"}
                  </Badge>
                </div>
                <div className="employee-card__actions">
                  <Button
                    onClick={() => router.push(`/ai-employees/${item.id}`)}
                    aria-label={`Run ${item.displayName}`}
                  >
                    Run
                  </Button>
                  {(() => {
                    const configureHref = EMPLOYEE_CONFIGURE_ROUTES[item.slug];
                    return configureHref ? (
                      <Link
                        href={configureHref}
                        aria-label={`Configure ${item.displayName}`}
                        className="employee-card__link"
                      >
                        Configure
                      </Link>
                    ) : null;
                  })()}
                </div>
              </div>
            ))}
          </div>
        ) : !uninstalled.length ? (
          <EmptyState
            title="No enabled AI employees"
            description="Create your first AI Employee by installing one below, then enable it."
          />
        ) : null}
        {uninstalled.length ? (
          <section className="employee-available-section">
            <h2>Available AI Employees</h2>
            <p>Install a built-in AI employee to get started.</p>
            <div className="employee-grid">
              {uninstalled.map((manifest) => (
                <div key={manifest.id} className="employee-card">
                  <div className="employee-card__header">
                    <div className="employee-card__icon" aria-hidden="true">
                      <Sparkles />
                    </div>
                    <div className="employee-card__body">
                      <h3>{manifest.displayName}</h3>
                      <p>{manifest.description}</p>
                    </div>
                  </div>
                  <div className="employee-card__badges">
                    <Badge>{manifest.version}</Badge>
                  </div>
                  <div className="employee-card__actions">
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
                  </div>
                </div>
              ))}
            </div>
            {install.isError ? (
              <Alert tone="danger" title="Installation failed">
                {agentRunErrorMessage(install.error)}
              </Alert>
            ) : null}
          </section>
        ) : null}
      </section>
    </AccessGate>
  );
}

/** Universal workforce entry point. The active receptionist is discovered from its declared
 * `workforce.intake` capability by the API, so this page does not encode an installation id. */
export function ReceptionistEntryPage() {
  const api = useApi();
  const frontDoor = useQuery({
    queryKey: ["receptionist", "front-door"],
    queryFn: api.receptionistFrontDoor
  });
  if (frontDoor.isLoading) return <Skeleton />;
  if (frontDoor.isError) {
    const state = receptionistFrontDoorError(frontDoor.error);
    return (
      <Alert tone="danger" title={state.title}>
        {state.message} Safe code: {state.safeCode}.
        {state.requestId ? ` Request ID: ${state.requestId}.` : ""}
      </Alert>
    );
  }
  const frontDoorData = frontDoor.data;
  if (!frontDoorData || !frontDoorData.enabled || !frontDoorData.pluginInstallationId) {
    const unavailable = {
      RECEPTIONIST_NOT_INSTALLED: {
        title: "AI Receptionist is not installed",
        description: "An organization administrator can install it from AI Employees."
      },
      RECEPTIONIST_DISABLED: {
        title: "AI Receptionist is disabled",
        description: "An organization administrator can enable the installed Receptionist."
      },
      RECEPTIONIST_NOT_CONFIGURED: {
        title: "AI Receptionist is not the web front door",
        description: "Enable the default web front-door setting in Receptionist configuration."
      }
    }[frontDoorData?.reasonCode ?? "RECEPTIONIST_NOT_INSTALLED"];
    return <EmptyState title={unavailable.title} description={unavailable.description} />;
  }
  return (
    <EmployeeChatPage
      employeeId={frontDoorData.pluginInstallationId}
      displayNameOverride={frontDoorData.displayName}
    />
  );
}

/** Dedicated chat page for a single AI employee (`/ai-employees/[id]`), reached from the "Run" button on
 * the employee grid. Previously the chat rendered inline below the full grid + install sections on the
 * same page, which meant clicking "Run" scrolled a long way down to a chat panel still surrounded by every
 * other employee card — this page shows just that one employee's chat with a Back link, like every other
 * detail route in the dashboard (execution-history/[id], team/[id], etc.). */
export function EmployeeChatPage({
  employeeId,
  displayNameOverride
}: {
  employeeId: string;
  displayNameOverride?: string;
}) {
  const api = useApi(),
    travel = useTravelApi(),
    qc = useQueryClient();
  const { client } = useAuth();
  const searchParams = useSearchParams();
  const deepLinkedConversationId = searchParams.get("conversationId");
  const q = useQuery({ queryKey: ["agents"], queryFn: api.employees });
  const installedEmployee = q.data?.find((item) => item.id === employeeId) ?? null;
  const employee =
    installedEmployee && displayNameOverride
      ? { ...installedEmployee, displayName: displayNameOverride }
      : installedEmployee;
  // Downloads a ticket PDF chat attachment via an authenticated blob fetch (never a plain <a href>/
  // window.open — the ticket.pdf route requires a bearer token, which a raw link/navigation can't carry).
  const downloadTicketMutation = useMutation({
    mutationFn: (attachment: { url: string; filename: string }) =>
      client.requestBlob(attachment.url).then((blob) => ({ blob, filename: attachment.filename })),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  });
  const [conversationId, setConversationId] = useState<string | undefined>(),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    // Files selected for upload but not yet sent — cleared once the message ships.
    [pendingFiles, setPendingFiles] = useState<File[]>([]),
    // Set only while the user has an unresolved "resume or start new?" choice for a stored conversation —
    // never auto-resumed. Cleared as soon as either choice is made.
    [resumeChoice, setResumeChoice] = useState<string | null>(null);
  // Uploads a selected file (PDF/DOCX/TXT/JPG/PNG) to the current conversation so its text can be read by
  // the AI Employee. Uploaded attachments are sent together with the next message via `attachmentIds`.
  const uploadAttachment = useMutation({
    mutationFn: async (file: File) => {
      if (!conversationId) throw new Error("CONVERSATION_REQUIRED");
      return api.uploadAttachment(conversationId, file);
    }
  });
  const run = useMutation({
    mutationFn: api.run,
    onSuccess: (result, variables) => {
      if (!result || typeof result !== "object") return;
      const r = result as unknown as Record<string, unknown>;
      const convId = typeof r.conversationId === "string" ? r.conversationId : "";
      const resp = typeof r.response === "string" ? r.response : "";
      const execId = typeof r.executionId === "string" ? r.executionId : "";
      const sources = Array.isArray(r.sources) ? r.sources : [];
      const attachments = Array.isArray(r.attachments) ? r.attachments : [];
      const receptionist =
        r.receptionist && typeof r.receptionist === "object"
          ? (r.receptionist as unknown as ReceptionistResult)
          : undefined;
      setConversationId(convId);
      if (resp) {
        setMessages((current) => [
          ...current,
          {
            role: "ASSISTANT",
            content: resp,
            executionId: execId,
            sources,
            attachments,
            ...(receptionist ? { receptionist } : {})
          }
        ]);
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
    // A conversation link from another employee's routing handoff (see agent.service.ts's
    // ROUTING_HANDOFF_FAILED/CONVERSATION_LINK path) always wins over the stored-conversation prompt below —
    // the user explicitly navigated here to continue a specific conversation, so there's no ambiguity to ask
    // about.
    if (deepLinkedConversationId) {
      resumeConversation(employee.id, deepLinkedConversationId);
      return;
    }
    // The Travel Employee and every shared-engine domain employee (HR, Finance, IT, Sales, Marketing,
    // Legal, Customer Support) proactively greet — every other AI employee keeps starting blank until
    // the user sends the first message, unchanged from before.
    if (!GREETING_EMPLOYEE_SLUGS.has(employee.slug)) return;
    const decision = decideConversationEntry(
      sessionStorage.getItem(conversationStorageKey(employee.id))
    );
    // A stored conversation id is never auto-resumed: resuming silently reuses whatever customer context
    // (name, trip state) that conversation had, which is exactly the isolation bug this guards against.
    // The user must explicitly choose — see the resume/new-conversation prompt in the render below.
    if (decision.action === "ASK_RESUME_OR_NEW") {
      setResumeChoice(decision.storedConversationId);
      return;
    }
    startNewConversation(employee.id);
    // `run`/`api`/`resumeConversation`/`deepLinkedConversationId` intentionally excluded: only the employee
    // identity should re-trigger this effect (a conversationId query param never changes without a fresh
    // navigation, which remounts the page anyway).
  }, [employee?.id]);
  const travelStateQuery = useQuery({
    queryKey: ["travel-state", employee?.id, conversationId],
    queryFn: () => travel.state(employee?.id ?? "", conversationId ?? ""),
    enabled: Boolean(employee?.slug === TRAVEL_EMPLOYEE_PLUGIN_ID && conversationId),
    retry: false
  });
  // Auto-scrolls the chat thread to the newest message — both the traveler's own reply (added immediately
  // in `submit`) and the assistant's response (added once `run` resolves) push a new entry onto `messages`,
  // so this fires for either. Runs after paint (`chatThreadRef.current.scrollHeight` reflects the just-
  // rendered content only once the DOM has updated), and again while `run.isPending` so a long-running
  // reply doesn't leave the thread scrolled to the traveler's own last message.
  const chatThreadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = chatThreadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, run.isPending]);
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "ASSISTANT");
  const placeholder = employee
    ? employeePlaceholder(
        employee.slug,
        travelStateQuery.data?.stage,
        Boolean(lastAssistantMessage?.sources?.length),
        Boolean(conversationId)
      )
    : "Type your message…";
  const isReceptionist = employee?.slug === RECEPTIONIST_PLUGIN_SLUG;
  // The Receptionist's own front-door welcome screen — shown until the customer has actually said
  // something. The proactive greeting (an ASSISTANT-only turn) does not count: it arrives automatically
  // on mount and would otherwise make the welcome screen flash away before anyone typed anything.
  const hasCustomerMessage = messages.some((message) => message.role === "USER");
  const showReceptionistWelcome = isReceptionist && !hasCustomerMessage;
  // Driven entirely by the backend's own handoff payload on the most recent assistant turn — never
  // inferred from message text — so this only ever reflects what ReceptionistService actually decided.
  const activeHandoff = isReceptionist
    ? [...messages].reverse().find((message) => message.role === "ASSISTANT" && message.receptionist?.handoff)
        ?.receptionist?.handoff
    : undefined;
  // Sends a plain text message through the exact same run.mutate() call the composer form uses — the
  // single path every message (typed or a quick-action shortcut) goes through, so there is only ever one
  // way a message reaches the Receptionist API.
  const sendMessage = (message: string) => {
    if (!employee || run.isPending) return;
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessages((current) => [...current, { role: "USER", content: trimmed }]);
    run.mutate({
      pluginInstallationId: employee.id,
      ...(conversationId ? { conversationId } : {}),
      message: trimmed
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!employee || run.isPending) return;
    const form = event.currentTarget,
      message = String(new FormData(form).get("message") ?? "").trim();
    const files = pendingFiles;
    if (!message && files.length === 0) return;
    if (files.length === 0) {
      sendMessage(message);
      form.reset();
      return;
    }
    setMessages((current) => [
      ...current,
      {
        role: "USER",
        content: message || `Attached ${files.length} file(s)`,
        fileAttachments: files.map((file) => file.name)
      }
    ]);
    setPendingFiles([]);
    // Upload each file, then send the message referencing the uploaded attachment ids.
    void (async () => {
      try {
        const uploaded = [];
        for (const file of files) {
          const record = await uploadAttachment.mutateAsync(file);
          uploaded.push(record.id);
        }
        run.mutate({
          pluginInstallationId: employee.id,
          ...(conversationId ? { conversationId } : {}),
          message,
          ...(uploaded.length ? { attachmentIds: uploaded } : {})
        });
      } catch {
        setMessages((current) => [
          ...current,
          {
            role: "ASSISTANT",
            content: "I couldn't upload that file. Please try a PDF, Word, text, or image file."
          }
        ]);
      }
    })();
    form.reset();
  };
  const onSelectFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const selected = Array.from(files).slice(0, 5);
    setPendingFiles((current) => [...current, ...selected].slice(0, 5));
  };
  return (
    <AccessGate permission="agents.run">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/ai-employees" label="Back to AI Employees" />
            <h1>{employee ? employee.displayName : "AI Employee"}</h1>
            {employee ? <p>{employee.description}</p> : null}
          </div>
        </header>
        {q.isLoading ? (
          <Skeleton />
        ) : q.isError ? (
          <Alert tone="danger" title="Unable to load AI employees" />
        ) : !employee ? (
          <EmptyState
            title="AI employee not found"
            description="It may have been removed, or you may not have access to it."
          />
        ) : resumeChoice ? (
          <Card>
            <h2>Chat with {employee.displayName}</h2>
            <p>
              You have a previous conversation with {employee.displayName}. Resume it, or start
              fresh?
            </p>
            <Button onClick={() => resumeConversation(employee.id, resumeChoice)}>
              Resume previous conversation
            </Button>{" "}
            <Button onClick={() => startNewConversation(employee.id)}>
              Start new conversation
            </Button>
          </Card>
        ) : (
          <Card className="chat-panel">
            <div className="chat-panel__header">
              <div className="chat-panel__avatar" aria-hidden="true">
                <Bot size={20} />
              </div>
              <div className="chat-panel__title">
                <h2>{employee.displayName}</h2>
                <span className="chat-panel__status">
                  {employee.runtimeReady
                    ? isReceptionist
                      ? "AI Receptionist ready"
                      : "Runtime ready"
                    : isReceptionist
                      ? "Getting ready…"
                      : "Limited — memory tools disabled"}
                </span>
              </div>
              {activeHandoff ? (
                <div className="chat-panel__active-employee">
                  <span className="chat-panel__active-employee-label">Currently helping</span>
                  <span className="chat-panel__active-employee-name">
                    {activeHandoff.targetDisplayName}
                  </span>
                </div>
              ) : null}
            </div>
            {showReceptionistWelcome ? (
              <div className="chat-welcome">
                <div className="chat-welcome__icon" aria-hidden="true">
                  <Sparkles size={26} />
                </div>
                <h3 className="chat-welcome__title">Hi, I&rsquo;m Krevia</h3>
                <p className="chat-welcome__subtitle">Your AI Workforce Receptionist</p>
                <p className="chat-welcome__hint">
                  Tell me what you need help with and I&rsquo;ll connect you with the right AI
                  employee.
                </p>
                <div className="chat-welcome__actions" role="group" aria-label="Quick actions">
                  {RECEPTIONIST_QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className="chat-quick-action focus-ring"
                      onClick={() => sendMessage(action.message)}
                      disabled={run.isPending}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-thread" aria-live="polite" ref={chatThreadRef}>
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
                      <div className="chat-bubble__avatar" aria-hidden="true">
                        {isUser ? <User size={15} /> : <Bot size={15} />}
                      </div>
                      <div className="chat-bubble__content">
                        {!isUser && message.receptionist?.handoff ? (
                          <div className="chat-handoff-indicator" role="status">
                            <span className="chat-handoff-indicator__label">Connected to</span>
                            <span className="chat-handoff-indicator__name">
                              {message.receptionist.handoff.targetDisplayName}
                            </span>
                          </div>
                        ) : null}
                        <span className="chat-bubble__author">
                          {isUser
                            ? "You"
                            : message.receptionist?.handoff?.displayMode === "TRANSPARENT_HANDOFF"
                              ? message.receptionist.handoff.targetDisplayName
                              : employee.displayName}
                        </span>
                        {itinerary ? (
                          <TravelItineraryCards itinerary={itinerary} />
                        ) : (
                          <p className="chat-bubble__text">{message.content}</p>
                        )}
                        {message.fileAttachments?.length ? (
                          <div className="chat-attachments chat-attachments--files">
                            {message.fileAttachments.map((name) => (
                              <span key={name} className="chat-attachment-file">
                                <FileText size={13} /> {name}
                              </span>
                            ))}
                          </div>
                        ) : null}
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
                        {message.attachments?.length ? (
                          <div className="chat-attachments">
                            {message.attachments.map((attachment) =>
                              attachment.type === "CONVERSATION_LINK" ? (
                                <Link
                                  key={attachment.conversationId}
                                  href={`/ai-employees/${attachment.employeeInstallationId}?conversationId=${attachment.conversationId}`}
                                  className="ui-button ui-button--ghost"
                                >
                                  {attachment.label}
                                </Link>
                              ) : (
                                <Button
                                  key={attachment.bookingId}
                                  variant="ghost"
                                  loading={
                                    downloadTicketMutation.isPending &&
                                    downloadTicketMutation.variables?.url === attachment.url
                                  }
                                  onClick={() => downloadTicketMutation.mutate(attachment)}
                                >
                                  <FileText size={14} /> Download Ticket PDF
                                </Button>
                              )
                            )}
                          </div>
                        ) : null}
                        {message.executionId ? (
                          <details className="chat-debug">
                            <summary>Debug</summary>
                            <div>
                              <Link href={`/execution-history/${message.executionId}`}>
                                View execution
                              </Link>
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {run.isError ? (
              <Alert tone="danger" title="Agent execution failed">
                {agentRunErrorMessage(run.error)}
              </Alert>
            ) : null}
            {pendingFiles.length ? (
              <div className="chat-composer__files">
                {pendingFiles.map((file) => (
                  <span key={file.name} className="chat-attachment-file">
                    <FileText size={13} /> {file.name}
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setPendingFiles((current) => current.filter((f) => f.name !== file.name))
                      }
                    >
                      <X size={13} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <form
              onSubmit={submit}
              className={`chat-composer${isReceptionist ? " chat-composer--receptionist" : ""}`}
            >
              <label className="chat-composer__attach" aria-label="Attach a file">
                <Paperclip size={18} />
                <input
                  type="file"
                  name="attachment"
                  accept=".pdf,.doc,.docx,.txt,.md,.jpg,.jpeg,.png,.webp"
                  multiple
                  hidden
                  disabled={!conversationId || run.isPending || uploadAttachment.isPending}
                  onChange={(event) => onSelectFiles(event.currentTarget.files)}
                />
              </label>
              <label htmlFor="agent-message" className="sr-only">
                Message
              </label>
              <Input
                id="agent-message"
                name="message"
                required={pendingFiles.length === 0}
                maxLength={12000}
                placeholder={placeholder}
                className="chat-composer__field"
                autoComplete="off"
              />
              <Button loading={run.isPending} disabled={run.isPending}>
                {!run.isPending ? <Send size={16} /> : null}
                Send
              </Button>
            </form>
          </Card>
        )}
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
                      {item.createdBy
                        ? `${item.createdBy.firstName} ${item.createdBy.lastName ?? ""}`.trim()
                        : "—"}
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
            <BackLink href="/conversations" label="Back to Conversations" />
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
            <BackLink href="/execution-history" label="Back to Execution History" />
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
