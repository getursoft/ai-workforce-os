import { randomBytes } from "node:crypto";

/**
 * Sprint 4.7 Phase 2/14: the platform trace-propagation contract. Field names and ID shapes are chosen to
 * be OpenTelemetry-compatible (traceId = 32 hex chars / 16 bytes, spanId = 16 hex chars / 8 bytes) so an
 * OTLP exporter (Phase 14, not built in this pass) can translate this shape directly without redesigning
 * it later. `sampled` is decided once, at trace start, and carried on every derived child context.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  correlationId: string | null;
  causationId: string | null;
  organizationId: string;
  conversationId?: string | null;
  agentExecutionId?: string | null;
  workflowExecutionId?: string | null;
  delegatedTaskId?: string | null;
  sampled: boolean;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Builds the context a new child span should carry — same trace, new spanId, parent = the current span. */
export function childContext(parent: TraceContext, overrides: Partial<TraceContext> = {}): TraceContext {
  return {
    ...parent,
    spanId: newSpanId(),
    parentSpanId: parent.spanId,
    ...overrides
  };
}

/** Rebuilds a TraceContext from a persisted traceId alone (e.g. read back off EmployeeDelegatedTask.traceId
 *  by the background processor, in a call stack with no live parent span) — the new span attaches to the
 *  same trace as a second top-level span rather than being dropped into a disconnected, new trace. */
export function rootedContext(
  organizationId: string,
  traceId: string,
  sampled: boolean,
  overrides: Partial<TraceContext> = {}
): TraceContext {
  return {
    traceId,
    spanId: newSpanId(),
    parentSpanId: null,
    correlationId: null,
    causationId: null,
    organizationId,
    sampled,
    ...overrides
  };
}
