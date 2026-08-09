import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Ajv, type ValidateFunction } from "ajv";
import type {
  SkillAdapter,
  SkillCapabilities,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillManifest
} from "@ai-workforce-os/skill-sdk";
import { versionSatisfies } from "@ai-workforce-os/skill-sdk";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillError } from "./skill-error";
import {
  safeSkillErrorCode,
  safeSkillErrorMessage
} from "./skill-error";
import type { SkillExecuteRequest, SkillExecuteResult } from "./skill-runtime.contracts";
import { buildSkillCapabilities, type SkillCapabilityServices } from "./skill-capabilities";
import { OBJECT_STORAGE } from "../storage/object-storage.types";
import type { ObjectStorageService } from "../storage/object-storage.types";
// Sprint 6.1B bug fix: these three MUST be regular (not `import type`) imports. They're used as
// constructor-injected `@Optional()` parameter TYPES, and Nest's DI resolves those via TypeScript's
// emitted `design:paramtypes` reflection metadata. A type-only import has no runtime value, so tsc
// emits a generic `Function` placeholder for that parameter position instead of the real class —
// which Nest then silently fails to resolve, injecting `undefined` even though the providers are
// correctly wired in the module graph. AuditEventLogger (a regular import below) was never affected,
// which is exactly what exposed the pattern: pluginAi/observability/entitlements were always
// undefined here, invisibly, since Sprint 6.1A shipped.
import { PluginAiService } from "../plugins/plugin-ai.service";
import { ObservabilityService } from "../observability/observability.service";
import type { TraceContext } from "../observability/trace-context";
import { tokensToCredits } from "../billing/billing.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { EntitlementService } from "../entitlements/entitlement.service";

const INPUT_SUMMARY_LIMIT = 4 * 1024;
const OUTPUT_SUMMARY_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

function summarizeJson(value: unknown, limit: number): Record<string, unknown> {
  try {
    const text = JSON.stringify(value);
    if (!text || text.length <= limit) return { value: value as Prisma.InputJsonValue };
    return { truncated: true, preview: text.slice(0, limit) };
  } catch {
    return { preview: String(value).slice(0, limit) };
  }
}

@Injectable()
export class SkillsRuntimeService {
  private readonly logger = new Logger(SkillsRuntimeService.name);
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly schemaCache = new Map<string, ValidateFunction>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStorageService,
    @Optional() private readonly pluginAi?: PluginAiService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly auditLogger?: AuditEventLogger,
    @Optional() private readonly entitlements?: EntitlementService
  ) {}

  // ------------------------------------------------------------------ public API

  /**
   * The single stable entry point employees, workflows and schedulers use to run a skill. Enforces
   * installation, employee grant, permissions, dependencies, schema, timeout and idempotency, and
   * persists the SkillRun with usage/billing/trace/audit records.
   */
  async execute(request: SkillExecuteRequest): Promise<SkillExecuteResult> {
    const organizationId = request.organizationId;
    const idempotencyKey =
      request.idempotencyKey ??
      `skill:${request.skillKey}:${crypto.randomUUID()}`;

    const existing = await this.findReplay(organizationId, request.skillKey, idempotencyKey);
    if (existing) return existing;

    const adapter = this.resolveAdapter(request.skillKey, request.versionConstraint);
    const manifest = adapter.manifest;

    const installation = await this.assertInstallation(organizationId, manifest.key, manifest.version);
    await this.assertMonthlyExecutionLimit(organizationId);
    if (request.pluginInstallationId) {
      await this.assertEmployeeGrant(
        organizationId,
        request.pluginInstallationId,
        installation.id
      );
    }

    await this.resolveDependencies(organizationId, manifest);

    const context = await this.buildContext(request, adapter, installation);

    return this.traced(
      request.traceContext,
      {
        name: `SKILL_EXECUTION:${manifest.key}`,
        spanType: "SKILL_EXECUTION",
        component: "SkillsRuntimeService",
        employeeInstallationId: request.pluginInstallationId ?? null,
        workflowExecutionId: request.workflowExecutionId ?? null,
        inputSummary: {
          skillKey: manifest.key,
          skillVersion: manifest.version,
          inputSize: summarizeJson(request.input, INPUT_SUMMARY_LIMIT)
        }
      },
      async (span) => {
        const traceId = span?.traceId ?? request.traceContext?.traceId ?? null;
        return this.executeResolved(
          request,
          adapter,
          manifest,
          context,
          installation.id,
          idempotencyKey,
          traceId
        );
      }
    );
  }

  /** Capability discovery (Phase 11): skills installed AND granted to an employee, with configuration
   *  merged. Never exposes disabled/unauthorised skills to prompt/tool selection. */
  async skillsForEmployee(
    organizationId: string,
    pluginInstallationId: string
  ): Promise<Array<{
    skillKey: string;
    name: string;
    description: string;
    category: string;
    version: string;
    supportedMimeTypes: string[];
    capabilitySummary: string[];
    configuration: Record<string, unknown>;
    installationId: string;
    enabled: boolean;
  }>> {
    const rows = await this.prisma.employeeSkillGrant.findMany({
      where: { organizationId, pluginInstallationId, enabled: true },
      include: {
        skillInstallation: {
          include: { skillVersion: { include: { skill: true } } }
        }
      }
    });
    return rows
      .filter(
        (row) =>
          row.skillInstallation.enabled === true &&
          row.skillInstallation.deletedAt === null
      )
      .map((row) => {
        const version = row.skillInstallation.skillVersion;
        const manifest = readManifest(version.manifestJson);
        return {
          skillKey: version.skill.key,
          name: version.skill.name,
          description: version.skill.description,
          category: version.skill.category,
          version: version.version,
          supportedMimeTypes: manifest?.supportedMimeTypes ?? [],
          capabilitySummary: manifest?.capabilitySummary ?? [],
          configuration: mergeConfiguration(
            readRecord(row.skillInstallation.configurationJson),
            readRecord(row.configurationOverrideJson)
          ),
          installationId: row.skillInstallationId,
          enabled: true
        };
      });
  }

  /** Latest execution summary for a skill installation (used by the Executions tab). Deliberately
   *  omits inputSummaryJson/outputSummaryJson — those may hold a truncated preview of the document
   *  or answer text a skill processed, and Phase 15/19 require execution history to never surface
   *  raw document content, only safe status/usage/billing metadata. */
  async executions(
    organizationId: string,
    skillInstallationId: string,
    page: { page: number; pageSize: number }
  ): Promise<{ items: unknown[]; total: number }> {
    const where: Prisma.SkillRunWhereInput = { organizationId, skillInstallationId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.skillRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        select: {
          id: true,
          skillKey: true,
          skillVersion: true,
          status: true,
          durationMs: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          creditsConsumed: true,
          retryCount: true,
          errorCode: true,
          errorMessageSafe: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          traceId: true,
          pluginInstallationId: true,
          workflowExecutionId: true,
          conversationId: true
        }
      }),
      this.prisma.skillRun.count({ where })
    ]);
    return { items, total };
  }

  async checkHealth(
    organizationId: string,
    skillInstallationId: string
  ): Promise<{ status: string; checks: unknown[]; checkedAt: string }> {
    const installation = await this.prisma.skillInstallation.findFirst({
      where: { id: skillInstallationId, organizationId, deletedAt: null },
      include: { skillVersion: { include: { skill: true } } }
    });
    if (!installation) throw new SkillError("SKILL_NOT_INSTALLED");
    const adapter = this.resolveAdapter(
      installation.skillVersion.skill.key,
      installation.skillVersion.version
    );
    const context = await this.buildContext(
      { organizationId, skillKey: installation.skillVersion.skill.key, input: {} },
      adapter,
      installation
    );
    return adapter.health(context);
  }

  // ------------------------------------------------------------------ private helpers

  private async executeResolved(
    request: SkillExecuteRequest,
    adapter: SkillAdapter,
    manifest: SkillManifest,
    context: SkillExecutionContext,
    skillInstallationId: string,
    idempotencyKey: string,
    traceId: string | null
  ): Promise<SkillExecuteResult> {
    const started = Date.now();
    const run = await this.createRun(request, manifest, skillInstallationId, idempotencyKey, traceId);

    const status = "COMPLETED" as const;
    let result: SkillExecutionResult | null = null;
    let errorCode: string | null = null;
    let errorMessageSafe: string | null = null;
    let retryCount = 0;

    try {
      this.validateSchema(`${manifest.key}@${manifest.version}:input`, manifest.inputSchema, request.input);
      await adapter.validate(request.input, context);

      const retryPolicy = manifest.retryPolicy;
      const maxRetries = Math.min(retryPolicy?.maxRetries ?? 0, MAX_RETRIES);
      for (let attempt = 0; ; attempt++) {
        try {
          result = await withTimeout(
            adapter.execute(request.input, context),
            manifest.timeoutMs ?? DEFAULT_TIMEOUT_MS
          );
          break;
        } catch (error) {
          retryCount = attempt + 1;
          if (attempt >= maxRetries) throw error;
          const backoff = (retryPolicy?.backoffMs ?? 100) * Math.pow(2, attempt);
          this.logger.warn({
            event: "SKILL_RUN_RETRY",
            skillKey: manifest.key,
            attempt,
            backoffMs: backoff,
            error: safeSkillErrorMessage(error)
          });
          await sleep(backoff);
        }
      }
      if (!result) throw new SkillError("SKILL_INTERNAL_ERROR");

      this.validateSchema(
        `${manifest.key}@${manifest.version}:output`,
        manifest.outputSchema,
        result.data,
        "SKILL_OUTPUT_INVALID"
      );

      const usage = {
        inputTokens: result.usage?.inputTokens ?? estimateTokens(request.input),
        outputTokens: result.usage?.outputTokens ?? estimateTokens(result.data),
        totalTokens:
          result.usage?.totalTokens ??
          (result.usage?.inputTokens ?? estimateTokens(request.input)) +
            (result.usage?.outputTokens ?? estimateTokens(result.data)),
        provider: result.usage?.provider ?? null,
        model: result.usage?.model ?? null
      };
      const creditsConsumed = tokensToCredits(usage.totalTokens);
      await this.completeRun(run.id, organizationIdOf(request), {
        status: "COMPLETED",
        outputSummary: summarizeJson(result.data, OUTPUT_SUMMARY_LIMIT),
        durationMs: Date.now() - started,
        usage,
        creditsConsumed,
        retryCount
      });
      await this.recordUsage(request, usage, creditsConsumed, idempotencyKey);
      this.recordAudit("SKILL_EXECUTION_COMPLETED", request, manifest, idempotencyKey, creditsConsumed);
      return {
        skillKey: manifest.key,
        skillVersion: manifest.version,
        runId: run.id,
        status,
        data: result.data as never,
        usage,
        creditsConsumed,
        durationMs: Date.now() - started,
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        retryCount
      };
    } catch (error) {
      errorCode = safeSkillErrorCode(error);
      errorMessageSafe = safeSkillErrorMessage(error);
      await this.completeRun(run.id, organizationIdOf(request), {
        status: "FAILED",
        errorCode,
        errorMessageSafe,
        durationMs: Date.now() - started,
        retryCount
      });
      this.recordAudit("SKILL_EXECUTION_FAILED", request, manifest, idempotencyKey, 0, errorCode);
      if (error instanceof SkillError) throw error;
      throw new SkillError(errorCode as never, errorMessageSafe);
    }
  }

  private async createRun(
    request: SkillExecuteRequest,
    manifest: SkillManifest,
    skillInstallationId: string,
    idempotencyKey: string,
    traceId: string | null
  ) {
    const organizationId = organizationIdOf(request);
    return this.prisma.skillRun.create({
      data: {
        organizationId,
        skillInstallationId,
        pluginInstallationId: request.pluginInstallationId ?? null,
        agentExecutionId: request.agentExecutionId ?? null,
        workflowExecutionId: request.workflowExecutionId ?? null,
        conversationId: request.conversationId ?? null,
        traceId,
        idempotencyKey,
        skillKey: manifest.key,
        skillVersion: manifest.version,
        status: "RUNNING",
        inputSummaryJson: summarizeJson(request.input, INPUT_SUMMARY_LIMIT) as Prisma.InputJsonValue,
        startedAt: new Date()
      }
    });
  }

  private async completeRun(
    runId: string,
    organizationId: string,
    input: {
      status: "COMPLETED" | "FAILED";
      outputSummary?: unknown;
      durationMs: number;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number; provider?: string | null; model?: string | null };
      creditsConsumed?: number;
      errorCode?: string | null;
      errorMessageSafe?: string | null;
      retryCount?: number;
    }
  ) {
    await this.prisma.skillRun.updateMany({
      where: { id: runId, organizationId },
      data: {
        status: input.status,
        ...(input.outputSummary
          ? { outputSummaryJson: input.outputSummary as Prisma.InputJsonValue }
          : {}),
        durationMs: input.durationMs,
        inputTokens: input.usage?.inputTokens ?? 0,
        outputTokens: input.usage?.outputTokens ?? 0,
        totalTokens: input.usage?.totalTokens ?? 0,
        creditsConsumed: input.creditsConsumed ?? 0,
        errorCode: input.errorCode ?? null,
        errorMessageSafe: input.errorMessageSafe ?? null,
        retryCount: input.retryCount ?? 0,
        completedAt: new Date()
      }
    });
  }

  private async findReplay(
    organizationId: string,
    skillKey: string,
    idempotencyKey: string
  ): Promise<SkillExecuteResult | null> {
    const run = await this.prisma.skillRun.findFirst({
      where: { organizationId, skillKey, idempotencyKey }
    });
    if (!run) return null;
    if (run.status !== "COMPLETED")
      throw new SkillError("SKILL_RUN_REPLAY", "An execution with this idempotency key is already in progress");
    const output = run.outputSummaryJson as { value?: unknown } | null;
    return {
      skillKey: run.skillKey,
      skillVersion: run.skillVersion,
      runId: run.id,
      status: "REPLAY",
      data: output?.value as never,
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        totalTokens: run.totalTokens
      },
      creditsConsumed: run.creditsConsumed,
      durationMs: run.durationMs,
      retryCount: run.retryCount
    };
  }

  private resolveAdapter(skillKey: string, versionConstraint?: string): SkillAdapter {
    const adapter = this.registry.resolveByConstraint(skillKey, versionConstraint);
    if (!adapter) throw new SkillError("SKILL_VERSION_NOT_FOUND");
    if (versionConstraint && !versionSatisfies(adapter.manifest.version, versionConstraint))
      throw new SkillError("SKILL_VERSION_NOT_FOUND");
    return adapter;
  }

  private async assertInstallation(
    organizationId: string,
    skillKey: string,
    version: string
  ): Promise<{ id: string; configurationJson: unknown }> {
    const installation = await this.prisma.skillInstallation.findFirst({
      where: {
        organizationId,
        deletedAt: null,
        skillVersion: { skill: { key: skillKey }, version }
      },
      select: { id: true, configurationJson: true, enabled: true, status: true }
    });
    if (!installation) throw new SkillError("SKILL_NOT_INSTALLED");
    if (!installation.enabled) throw new SkillError("SKILL_DISABLED");
    return { id: installation.id, configurationJson: installation.configurationJson };
  }

  /** Sprint 6.1 — Phase 17 entitlement: caps skill executions per organization per calendar month.
   *  A rolling count against SkillRun (not a separate ledger), so it can never drift from reality. */
  private async assertMonthlyExecutionLimit(organizationId: string): Promise<void> {
    if (!this.entitlements) return;
    const limit = await this.entitlements.getLimit(organizationId, "SKILLS_EXECUTION_MONTHLY_LIMIT");
    if (!Number.isFinite(limit)) return;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const used = await this.prisma.skillRun.count({
      where: { organizationId, createdAt: { gte: monthStart } }
    });
    if (used >= limit) throw new SkillError("SKILL_LIMIT_REACHED", "Monthly skill execution limit reached for this organization");
  }

  private async assertEmployeeGrant(
    organizationId: string,
    pluginInstallationId: string,
    skillInstallationId: string
  ): Promise<void> {
    const grant = await this.prisma.employeeSkillGrant.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        skillInstallationId,
        enabled: true
      }
    });
    if (!grant) throw new SkillError("SKILL_EMPLOYEE_GRANT_DENIED");
  }

  private async resolveDependencies(
    organizationId: string,
    manifest: SkillManifest
  ): Promise<void> {
    for (const dependency of manifest.dependencies ?? []) {
      if (!dependency.required) continue;
      const installed = await this.prisma.skillInstallation.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          enabled: true,
          skillVersion: { skill: { key: dependency.skillKey }, status: "PUBLISHED" }
        },
        include: { skillVersion: true }
      });
      if (!installed) throw new SkillError("SKILL_DEPENDENCY_MISSING", `Dependency ${dependency.skillKey} is not installed`);
      if (!versionSatisfies(installed.skillVersion.version, dependency.versionConstraint))
        throw new SkillError(
          "SKILL_DEPENDENCY_VERSION_CONFLICT",
          `Dependency ${dependency.skillKey} requires ${dependency.versionConstraint}`
        );
    }
  }

  private async buildContext(
    request: SkillExecuteRequest,
    adapter: SkillAdapter,
    installation: { id: string; configurationJson: unknown }
  ): Promise<SkillExecutionContext> {
    const manifest = adapter.manifest;
    const override = request.pluginInstallationId
      ? await this.prisma.employeeSkillGrant.findFirst({
          where: {
            organizationId: request.organizationId,
            pluginInstallationId: request.pluginInstallationId,
            skillInstallationId: installation.id
          },
          select: { configurationOverrideJson: true }
        })
      : null;
    const configuration = mergeConfiguration(
      readRecord(installation.configurationJson),
      readRecord(override?.configurationOverrideJson)
    );
    const organization = await this.prisma.organization.findUnique({
      where: { id: request.organizationId },
      select: { settings: { select: { locale: true, timezone: true } } }
    });

    const services: SkillCapabilityServices = {
      objectStorage: this.objectStorage,
      pluginAi: this.pluginAi ?? null
    };

    return {
      organizationId: request.organizationId,
      pluginInstallationId: request.pluginInstallationId ?? null,
      userId: request.userId ?? null,
      conversationId: request.conversationId ?? null,
      agentExecutionId: request.agentExecutionId ?? null,
      workflowExecutionId: request.workflowExecutionId ?? null,
      traceId: request.traceContext?.traceId ?? null,
      grantedPermissions: new Set(manifest.requiredPermissions),
      grantedCapabilities: new Set(manifest.requiredCapabilities),
      configuration,
      locale: organization?.settings?.locale ?? null,
      timezone: organization?.settings?.timezone ?? null,
      idempotencyKey: request.idempotencyKey ?? "undefined",
      requestId: request.requestId ?? null,
      capabilities: buildSkillCapabilities(
        {
          organizationId: request.organizationId,
          pluginInstallationId: request.pluginInstallationId ?? null,
          userId: request.userId ?? null,
          conversationId: request.conversationId ?? null,
          agentExecutionId: request.agentExecutionId ?? null,
          workflowExecutionId: request.workflowExecutionId ?? null,
          traceId: request.traceContext?.traceId ?? null,
          grantedPermissions: new Set(manifest.requiredPermissions),
          grantedCapabilities: new Set(manifest.requiredCapabilities),
          configuration,
          locale: organization?.settings?.locale ?? null,
          timezone: organization?.settings?.timezone ?? null,
          idempotencyKey: request.idempotencyKey ?? "undefined",
          requestId: request.requestId ?? null,
          capabilities: {} as SkillCapabilities
        },
        services
      )
    };
  }

  private validateSchema(
    cacheKey: string,
    schema: Record<string, unknown>,
    value: unknown,
    errorCode: "SKILL_INPUT_INVALID" | "SKILL_OUTPUT_INVALID" = "SKILL_INPUT_INVALID"
  ): void {
    let validate = this.schemaCache.get(cacheKey);
    if (!validate) {
      try {
        validate = this.ajv.compile(schema);
      } catch {
        throw new SkillError(errorCode, "Skill schema is invalid");
      }
      this.schemaCache.set(cacheKey, validate);
    }
    if (!validate(value)) throw new SkillError(errorCode);
  }

  private async recordUsage(
    request: SkillExecuteRequest,
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; provider?: string | null; model?: string | null },
    creditsConsumed: number,
    idempotencyKey: string
  ): Promise<void> {
    try {
      await this.prisma.usageEvent.create({
        data: {
          organizationId: request.organizationId,
          pluginInstallationId: request.pluginInstallationId ?? null,
          agentExecutionId: request.agentExecutionId ?? null,
          conversationId: request.conversationId ?? null,
          provider: usage.provider ?? null,
          model: usage.model ?? null,
          usageType: "SKILL_EXECUTION",
          capability: request.skillKey,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          creditsConsumed,
          occurredAt: new Date(),
          idempotencyKey: `skill-run:${idempotencyKey}`
        }
      });
    } catch (error) {
      // A usage record must never fail a successful execution; log and continue (matches the platform's
      // "usage is derived/observational" stance). Duplicate keys are expected when a replay is retried.
      this.logger.warn({ event: "SKILL_USAGE_RECORD_FAILED", error: String(error) });
    }
  }

  private recordAudit(
    event: string,
    request: SkillExecuteRequest,
    manifest: SkillManifest,
    idempotencyKey: string,
    creditsConsumed: number,
    errorCode?: string
  ): void {
    this.auditLogger?.record(event, request.requestId ?? "skill-runtime", {
      organizationId: request.organizationId,
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.pluginInstallationId ? { employeeInstallationId: request.pluginInstallationId } : {}),
      skillKey: manifest.key,
      skillVersion: manifest.version,
      runId: idempotencyKey.slice(0, 40),
      creditsConsumed,
      ...(errorCode ? { errorCode } : {})
    });
  }

  private async traced<T>(
    context: TraceContext | null | undefined,
    metadata: Parameters<ObservabilityService["withSpan"]>[1],
    callback: (span: TraceContext | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.observability) return callback(context ?? undefined);
    return this.observability.withSpan(context, metadata, callback);
  }
}

function organizationIdOf(request: SkillExecuteRequest): string {
  return request.organizationId;
}

function readManifest(value: unknown): SkillManifest | null {
  if (!value || typeof value !== "object") return null;
  return value as SkillManifest;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mergeConfiguration(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  return { ...base, ...override };
}

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.max(1, Math.ceil(text.length / 4));
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolvePromise, reject) => {
    timer = setTimeout(() => reject(new SkillError("SKILL_TIMEOUT")), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
