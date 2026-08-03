import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { childContext, newSpanId, newTraceId, type TraceContext } from "./trace-context";
import { TraceContextStore } from "./trace-context.store";
import { ObservabilityOtelExporterService } from "./observability-otel-exporter.service";
import { sanitizeForTrace } from "./observability-sanitizer";
import type {
  SpanMetadata,
  SpanOutcome,
  SpanView,
  StartTraceInput,
  TraceTreeView,
  TraceView
} from "./observability.types";

function safeErrorInfo(error: unknown): { code: string; message: string } {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    const message = "message" in error && typeof (error as { message: unknown }).message === "string" ? (error as { message: string }).message : code;
    return { code, message: message.slice(0, 500) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "UNKNOWN_ERROR", message: message.slice(0, 500) };
}

/**
 * Sprint 4.7 Phase 3: the single place that writes ExecutionTrace/ExecutionSpan rows. Every raw value
 * passed in is routed through the sanitizer (Phase 24) before it is ever persisted — callers never write
 * to these tables directly. Every database write here is wrapped so a tracing failure is logged and
 * swallowed, never thrown — instrumentation must never fail the business request it is observing.
 */
@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly settingsCache = new Map<string, { tracingEnabled: boolean; sampleRate: number; expiresAt: number }>();
  private static readonly SETTINGS_CACHE_TTL_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly traceContextStore: TraceContextStore,
    private readonly otelExporter: ObservabilityOtelExporterService
  ) {}

  private safe<T>(op: string, fn: () => Promise<T>): Promise<T | undefined> {
    return fn().catch((error: unknown) => {
      this.logger.warn({ event: "ObservabilityWriteFailed", op, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
  }

  private async getSampling(organizationId: string): Promise<{ tracingEnabled: boolean; sampleRate: number }> {
    const cached = this.settingsCache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    try {
      const row = await this.prisma.observabilitySettings.findUnique({ where: { organizationId } });
      const value = {
        tracingEnabled: row?.tracingEnabled ?? true,
        sampleRate: row?.sampleRate ?? 1,
        expiresAt: Date.now() + ObservabilityService.SETTINGS_CACHE_TTL_MS
      };
      this.settingsCache.set(organizationId, value);
      return value;
    } catch {
      return { tracingEnabled: true, sampleRate: 1 };
    }
  }

  invalidateSettingsCache(organizationId: string): void {
    this.settingsCache.delete(organizationId);
  }

  // ---------------------------------------------------------------------
  // Trace lifecycle
  // ---------------------------------------------------------------------

  async startTrace(input: StartTraceInput): Promise<TraceContext> {
    const { tracingEnabled, sampleRate } = await this.getSampling(input.organizationId);
    const traceId = newTraceId();
    const rootSpanId = newSpanId();
    const sampled = tracingEnabled && Math.random() < sampleRate;
    const context: TraceContext = {
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      correlationId: null,
      causationId: null,
      organizationId: input.organizationId,
      conversationId: input.conversationId ?? null,
      sampled
    };
    if (sampled) {
      await this.safe("startTrace", () =>
        this.prisma.executionTrace.create({
          data: {
            organizationId: input.organizationId,
            traceId,
            rootSpanId,
            parentTraceId: input.parentTraceId ?? null,
            conversationId: input.conversationId ?? null,
            channelConnectionId: input.channelConnectionId ?? null,
            actorType: input.actorType,
            actorId: input.actorId ?? null,
            status: "RUNNING",
            metadataJson: sanitizeForTrace(input.metadata ?? {}) as Prisma.InputJsonValue
          }
        })
      );
    }
    return context;
  }

  /** Backfills the trace's business-entity linkage columns once they're known — a new conversation's id
   *  (and the AgentExecution row's id) only exist partway through AgentService.execute(), well after
   *  startTrace() already had to run to create the root span. Safe to call multiple times/redundantly. */
  async linkTrace(
    context: TraceContext,
    entities: { conversationId?: string; agentExecutionId?: string; workflowExecutionId?: string; delegatedTaskId?: string }
  ): Promise<void> {
    if (!context.sampled) return;
    await this.safe("linkTrace", () =>
      this.prisma.executionTrace.updateMany({
        where: { traceId: context.traceId },
        data: {
          ...(entities.conversationId ? { conversationId: entities.conversationId } : {}),
          ...(entities.agentExecutionId ? { agentExecutionId: entities.agentExecutionId } : {}),
          ...(entities.workflowExecutionId ? { workflowExecutionId: entities.workflowExecutionId } : {}),
          ...(entities.delegatedTaskId ? { delegatedTaskId: entities.delegatedTaskId } : {})
        }
      })
    );
  }

  async completeTrace(context: TraceContext, startedAtMs: number, metadata?: Record<string, unknown>): Promise<void> {
    if (!context.sampled) return;
    await this.safe("completeTrace", () =>
      this.prisma.executionTrace.updateMany({
        where: { traceId: context.traceId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
          ...(metadata ? { metadataJson: sanitizeForTrace(metadata) as Prisma.InputJsonValue } : {})
        }
      })
    );
  }

  async failTrace(context: TraceContext, startedAtMs: number, error: unknown): Promise<void> {
    const { code, message } = safeErrorInfo(error);
    if (!context.sampled) return;
    await this.safe("failTrace", () =>
      this.prisma.executionTrace.updateMany({
        where: { traceId: context.traceId },
        data: { status: "FAILED", completedAt: new Date(), durationMs: Date.now() - startedAtMs, errorCode: code, errorMessageSafe: message }
      })
    );
  }

  // ---------------------------------------------------------------------
  // Span lifecycle
  // ---------------------------------------------------------------------

  async startSpan(context: TraceContext, metadata: SpanMetadata): Promise<TraceContext> {
    const child = childContext(context);
    if (context.sampled) {
      await this.safe("startSpan", () =>
        this.prisma.executionSpan.create({
          data: {
            organizationId: context.organizationId,
            traceId: context.traceId,
            spanId: child.spanId,
            parentSpanId: context.spanId,
            name: metadata.name,
            spanType: metadata.spanType,
            component: metadata.component,
            employeeInstallationId: metadata.employeeInstallationId ?? null,
            workflowExecutionId: metadata.workflowExecutionId ?? null,
            delegatedTaskId: metadata.delegatedTaskId ?? null,
            status: "RUNNING",
            inputSummaryJson: sanitizeForTrace(metadata.inputSummary ?? null) as Prisma.InputJsonValue
          }
        })
      );
    }
    return child;
  }

  async completeSpan(context: TraceContext, startedAtMs: number, outcome?: SpanOutcome): Promise<void> {
    if (!context.sampled) return;
    await this.safe("completeSpan", () =>
      this.prisma.executionSpan.updateMany({
        where: { spanId: context.spanId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
          outputSummaryJson: sanitizeForTrace(outcome?.outputSummary ?? null) as Prisma.InputJsonValue,
          ...(outcome?.attributes ? { attributesJson: sanitizeForTrace(outcome.attributes) as Prisma.InputJsonValue } : {})
        }
      })
    );
  }

  /** Always captures the failure — even for an unsampled trace, per Phase 15's "errors may be sampled at
   *  100%" rule. An unsampled failure gets a minimal, disconnected trace+span pair created just for it
   *  (better than losing the error entirely); a sampled failure updates its already-existing row. */
  async failSpan(context: TraceContext, metadata: SpanMetadata, startedAtMs: number, error: unknown): Promise<void> {
    const { code, message } = safeErrorInfo(error);
    if (context.sampled) {
      await this.safe("failSpan", () =>
        this.prisma.executionSpan.updateMany({
          where: { spanId: context.spanId },
          data: { status: "FAILED", completedAt: new Date(), durationMs: Date.now() - startedAtMs, errorCode: code, errorMessageSafe: message }
        })
      );
      return;
    }
    await this.safe("failSpanForced", async () => {
      await this.prisma.executionTrace.create({
        data: {
          organizationId: context.organizationId,
          traceId: context.traceId,
          rootSpanId: context.spanId,
          conversationId: context.conversationId ?? null,
          actorType: "SYSTEM",
          status: "FAILED",
          startedAt: new Date(startedAtMs),
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
          errorCode: code,
          errorMessageSafe: message,
          metadataJson: { forcedByError: true }
        }
      });
      await this.prisma.executionSpan.create({
        data: {
          organizationId: context.organizationId,
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: context.parentSpanId,
          name: metadata.name,
          spanType: metadata.spanType,
          component: metadata.component,
          employeeInstallationId: metadata.employeeInstallationId ?? null,
          status: "FAILED",
          startedAt: new Date(startedAtMs),
          completedAt: new Date(),
          durationMs: Date.now() - startedAtMs,
          errorCode: code,
          errorMessageSafe: message
        }
      });
    });
  }

  async addAttribute(context: TraceContext, key: string, value: unknown): Promise<void> {
    if (!context.sampled) return;
    await this.safe("addAttribute", async () => {
      const span = await this.prisma.executionSpan.findUnique({ where: { spanId: context.spanId } });
      const attributes = (span?.attributesJson as Record<string, unknown> | null) ?? {};
      await this.prisma.executionSpan.updateMany({
        where: { spanId: context.spanId },
        data: { attributesJson: sanitizeForTrace({ ...attributes, [key]: value }) as Prisma.InputJsonValue }
      });
    });
  }

  /** Lightweight point-in-time event, stored as an entry inside the span's own attributesJson.events —
   *  there is no separate event table in this pass (kept additive/minimal per Phase 1's model list). */
  async addEvent(context: TraceContext, name: string, data?: Record<string, unknown>): Promise<void> {
    if (!context.sampled) return;
    await this.safe("addEvent", async () => {
      const span = await this.prisma.executionSpan.findUnique({ where: { spanId: context.spanId } });
      const attributes = (span?.attributesJson as Record<string, unknown> | null) ?? {};
      const events = Array.isArray(attributes.events) ? (attributes.events as unknown[]) : [];
      events.push(sanitizeForTrace({ name, at: new Date().toISOString(), ...data }));
      await this.prisma.executionSpan.updateMany({
        where: { spanId: context.spanId },
        data: { attributesJson: { ...attributes, events } as Prisma.InputJsonValue }
      });
    });
  }

  /** Records a numeric metric as a span attribute — Phase 13's aggregate metrics are computed by reading
   *  back ExecutionTrace/ExecutionSpan rows directly (durationMs, tokens in attributesJson), not from a
   *  separate metrics store, so this exists mainly for ad hoc counters that don't fit an existing column. */
  async recordMetric(context: TraceContext, name: string, value: number, unit?: string): Promise<void> {
    await this.addAttribute(context, `metric.${name}`, unit ? { value, unit } : value);
  }

  async recordError(context: TraceContext, code: string, messageSafe: string): Promise<void> {
    if (!context.sampled) return;
    await this.safe("recordError", () =>
      this.prisma.executionSpan.updateMany({
        where: { spanId: context.spanId },
        data: { errorCode: code, errorMessageSafe: messageSafe.slice(0, 500) }
      })
    );
  }

  /**
   * Wraps a unit of work in a span: creates it, runs the callback, times it, marks COMPLETED or FAILED,
   * and always rethrows the callback's error unchanged — tracing never swallows a business failure. When
   * `context` is null/undefined this also starts a brand-new trace (this call becomes the trace root);
   * when a context is passed, this creates a child span under the same trace.
   */
  /** The root span (spanId === trace.rootSpanId, parentSpanId null) needs its own ExecutionSpan row too —
   *  startTrace() only creates the ExecutionTrace row. Without this, a fresh trace's own top-level span
   *  (e.g. the AGENT_EXECUTION span for a brand-new chat turn) would never appear in getTraceTree(). */
  private async createRootSpan(context: TraceContext, metadata: SpanMetadata): Promise<void> {
    if (!context.sampled) return;
    await this.safe("createRootSpan", () =>
      this.prisma.executionSpan.create({
        data: {
          organizationId: context.organizationId,
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: null,
          name: metadata.name,
          spanType: metadata.spanType,
          component: metadata.component,
          employeeInstallationId: metadata.employeeInstallationId ?? null,
          workflowExecutionId: metadata.workflowExecutionId ?? null,
          delegatedTaskId: metadata.delegatedTaskId ?? null,
          status: "RUNNING",
          inputSummaryJson: sanitizeForTrace(metadata.inputSummary ?? null) as Prisma.InputJsonValue
        }
      })
    );
  }

  async withSpan<T>(
    context: TraceContext | null | undefined,
    metadata: SpanMetadata & { organizationId?: string; actorType?: string; actorId?: string | null; conversationId?: string | null; traceMetadata?: Record<string, unknown> },
    callback: (span: TraceContext) => Promise<T>
  ): Promise<T> {
    const isRoot = !context;
    const rootContext = context ?? (await this.startTrace({
      organizationId: metadata.organizationId ?? "",
      actorType: metadata.actorType ?? "SYSTEM",
      actorId: metadata.actorId ?? null,
      conversationId: metadata.conversationId ?? null,
      ...(metadata.traceMetadata ? { metadata: metadata.traceMetadata } : {})
    }));
    const span = isRoot ? { ...rootContext } : await this.startSpan(rootContext, metadata);
    if (isRoot) await this.createRootSpan(rootContext, metadata);
    const startedAtMs = Date.now();
    // Sprint 4.7A: every nested call within this span's callback (however many layers of business logic
    // deep — including files this pass must not modify, like WorkflowCoordinator) can read this exact
    // span via TraceContextStore.get() without it being passed as an explicit parameter.
    try {
      const result = await this.traceContextStore.run(span, () => callback(span));
      await this.completeSpan(span, startedAtMs);
      if (isRoot) await this.completeTrace(rootContext, startedAtMs);
      this.otelExporter.exportSpan({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: metadata.name,
        spanType: metadata.spanType,
        component: metadata.component,
        status: "COMPLETED",
        startedAtMs,
        durationMs: Date.now() - startedAtMs
      });
      return result;
    } catch (error) {
      await this.failSpan(span, metadata, startedAtMs, error);
      if (isRoot) await this.failTrace(rootContext, startedAtMs, error);
      this.otelExporter.exportSpan({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: metadata.name,
        spanType: metadata.spanType,
        component: metadata.component,
        status: "FAILED",
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        errorCode: safeErrorInfo(error).code
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  private toTraceView(row: {
    id: string; traceId: string; organizationId: string; rootSpanId: string; parentTraceId: string | null;
    conversationId: string | null; agentExecutionId: string | null; workflowExecutionId: string | null;
    delegatedTaskId: string | null; channelConnectionId: string | null; actorType: string; actorId: string | null;
    status: string; startedAt: Date; completedAt: Date | null; durationMs: number | null; errorCode: string | null;
    errorMessageSafe: string | null; metadataJson: unknown;
  }): TraceView {
    return {
      id: row.id,
      traceId: row.traceId,
      organizationId: row.organizationId,
      rootSpanId: row.rootSpanId,
      parentTraceId: row.parentTraceId,
      conversationId: row.conversationId,
      agentExecutionId: row.agentExecutionId,
      workflowExecutionId: row.workflowExecutionId,
      delegatedTaskId: row.delegatedTaskId,
      channelConnectionId: row.channelConnectionId,
      actorType: row.actorType,
      actorId: row.actorId,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      errorMessageSafe: row.errorMessageSafe,
      metadata: (row.metadataJson as Record<string, unknown>) ?? {}
    };
  }

  private toSpanView(row: {
    id: string; traceId: string; spanId: string; parentSpanId: string | null; name: string; spanType: string;
    component: string; employeeInstallationId: string | null; workflowExecutionId: string | null;
    delegatedTaskId: string | null; status: string; startedAt: Date; completedAt: Date | null; durationMs: number | null;
    inputSummaryJson: unknown; outputSummaryJson: unknown; errorCode: string | null; errorMessageSafe: string | null;
    attributesJson: unknown;
  }): SpanView {
    return {
      id: row.id,
      traceId: row.traceId,
      spanId: row.spanId,
      parentSpanId: row.parentSpanId,
      name: row.name,
      spanType: row.spanType,
      component: row.component,
      employeeInstallationId: row.employeeInstallationId,
      workflowExecutionId: row.workflowExecutionId,
      delegatedTaskId: row.delegatedTaskId,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
      inputSummary: row.inputSummaryJson,
      outputSummary: row.outputSummaryJson,
      errorCode: row.errorCode,
      errorMessageSafe: row.errorMessageSafe,
      attributes: (row.attributesJson as Record<string, unknown> | null) ?? null,
      children: []
    };
  }

  async getTrace(organizationId: string, traceId: string): Promise<TraceView | null> {
    const row = await this.prisma.executionTrace.findFirst({ where: { organizationId, traceId } });
    return row ? this.toTraceView(row) : null;
  }

  async listTraces(
    organizationId: string,
    filters: {
      status?: string;
      employeeInstallationId?: string;
      workflowType?: string;
      channelConnectionId?: string;
      correlationId?: string;
      errorCode?: string;
      dateFrom?: Date;
      dateTo?: Date;
    } = {},
    page: { page: number; pageSize: number } = { page: 1, pageSize: 25 }
  ): Promise<{ items: TraceView[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.ExecutionTraceWhereInput = {
      organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.channelConnectionId ? { channelConnectionId: filters.channelConnectionId } : {}),
      ...(filters.errorCode ? { errorCode: filters.errorCode } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? { startedAt: { ...(filters.dateFrom ? { gte: filters.dateFrom } : {}), ...(filters.dateTo ? { lte: filters.dateTo } : {}) } }
        : {})
    };
    const [total, rows] = await Promise.all([
      this.prisma.executionTrace.count({ where }),
      this.prisma.executionTrace.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      })
    ]);
    return { items: rows.map((row) => this.toTraceView(row)), total, page: page.page, pageSize: page.pageSize };
  }

  async getTraceTree(organizationId: string, traceId: string): Promise<TraceTreeView | null> {
    const traceRow = await this.prisma.executionTrace.findFirst({ where: { organizationId, traceId } });
    if (!traceRow) return null;
    const spanRows = await this.prisma.executionSpan.findMany({
      where: { organizationId, traceId },
      orderBy: { startedAt: "asc" }
    });
    const bySpanId = new Map<string, SpanView>();
    for (const row of spanRows) bySpanId.set(row.spanId, this.toSpanView(row));
    const orphanSpans: SpanView[] = [];
    let root: SpanView | null = null;
    for (const span of bySpanId.values()) {
      if (span.spanId === traceRow.rootSpanId) {
        root = span;
        continue;
      }
      const parent = span.parentSpanId ? bySpanId.get(span.parentSpanId) : undefined;
      if (parent) parent.children.push(span);
      else orphanSpans.push(span);
    }
    return { trace: this.toTraceView(traceRow), root, orphanSpans };
  }
}
