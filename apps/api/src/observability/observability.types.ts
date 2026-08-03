export type SpanType =
  | "HTTP_REQUEST"
  | "CHANNEL_MESSAGE"
  | "AGENT_EXECUTION"
  | "INTENT_CLASSIFICATION"
  | "EMPLOYEE_ROUTING"
  | "MEMORY_RECALL"
  | "KNOWLEDGE_SEARCH"
  | "PROMPT_BUILD"
  | "PROVIDER_CALL"
  | "TOOL_CALL"
  | "WORKFLOW_SIGNAL"
  | "WORKFLOW_STEP"
  | "APPROVAL_WAIT"
  | "DELEGATION"
  | "PARALLEL_JOIN"
  | "BACKGROUND_TASK"
  | "RESPONSE_COMPOSITION"
  | "MESSAGE_DELIVERY"
  | "BILLING_RECORD"
  | "ERROR";

export type TraceStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface StartTraceInput {
  organizationId: string;
  actorType: string;
  actorId?: string | null;
  conversationId?: string | null;
  channelConnectionId?: string | null;
  parentTraceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SpanMetadata {
  name: string;
  spanType: SpanType;
  component: string;
  employeeInstallationId?: string | null;
  workflowExecutionId?: string | null;
  delegatedTaskId?: string | null;
  inputSummary?: unknown;
}

export interface SpanOutcome {
  outputSummary?: unknown;
  attributes?: Record<string, unknown>;
}

export interface TraceView {
  id: string;
  traceId: string;
  organizationId: string;
  rootSpanId: string;
  parentTraceId: string | null;
  conversationId: string | null;
  agentExecutionId: string | null;
  workflowExecutionId: string | null;
  delegatedTaskId: string | null;
  channelConnectionId: string | null;
  actorType: string;
  actorId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  metadata: Record<string, unknown>;
}

export interface SpanView {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  spanType: string;
  component: string;
  employeeInstallationId: string | null;
  workflowExecutionId: string | null;
  delegatedTaskId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  inputSummary: unknown;
  outputSummary: unknown;
  errorCode: string | null;
  errorMessageSafe: string | null;
  attributes: Record<string, unknown> | null;
  children: SpanView[];
}

export interface TraceTreeView {
  trace: TraceView;
  root: SpanView | null;
  orphanSpans: SpanView[];
}
