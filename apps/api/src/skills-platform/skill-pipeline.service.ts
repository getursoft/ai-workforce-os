import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillsRuntimeService, withTimeout } from "./skill-runtime.service";
import { SkillError } from "./skill-error";
import type { CreateSkillPipelineInput, ExecuteSkillPipelineInput } from "./skill-pipeline.contracts";
import { evaluateCondition } from "./skill-pipeline-condition";
// Must be a regular (not `import type`) import — see the identical fix + explanation in
// skill-runtime.service.ts: a type-only import here breaks Nest's reflection-based @Optional() DI.
import { ObservabilityService } from "../observability/observability.service";
import type { TraceContext } from "../observability/trace-context";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

const MAX_NODE_RETRIES = 5;
const NODE_RETRY_BACKOFF_MS = 200;

/**
 * Sprint 6.1B Feature 1 — Skill Chaining Engine. Orchestrates a reusable, ordered chain of skill
 * executions. Every node runs through the existing SkillsRuntimeService.execute() — this service
 * never calls a skill adapter directly and never bypasses installation, employee grants, RBAC,
 * schema validation, billing, or audit. It only adds sequencing, conditional branching, failure
 * policy (stop/continue), pipeline-level timeout/retry, and the execution-graph record the dashboard
 * renders (Feature 7).
 */
@Injectable()
export class SkillPipelineService {
  private readonly logger = new Logger(SkillPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService,
    private readonly runtime: SkillsRuntimeService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() private readonly auditLogger?: AuditEventLogger
  ) {}

  // ------------------------------------------------------------------ pipeline definitions

  async createPipeline(organizationId: string, userId: string, input: CreateSkillPipelineInput, requestId?: string) {
    if (!input.nodes || input.nodes.length === 0)
      throw new SkillError("SKILL_PIPELINE_NODE_INVALID", "A pipeline must declare at least one node");

    const orders = new Set<number>();
    for (const node of input.nodes) {
      if (orders.has(node.order))
        throw new SkillError("SKILL_PIPELINE_NODE_INVALID", `Duplicate node order: ${node.order}`);
      orders.add(node.order);
      if (!this.registry.manifest(node.skillKey))
        throw new SkillError("SKILL_PIPELINE_NODE_INVALID", `Unknown skill key: ${node.skillKey}`);
      if (node.maxRetries !== undefined && (node.maxRetries < 0 || node.maxRetries > MAX_NODE_RETRIES))
        throw new SkillError("SKILL_PIPELINE_NODE_INVALID", `maxRetries must be between 0 and ${MAX_NODE_RETRIES}`);
    }

    const pipeline = await this.prisma.skillPipeline.create({
      data: {
        organizationId,
        name: input.name,
        description: input.description,
        createdByUserId: userId,
        nodes: {
          create: input.nodes
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((node) => ({
              order: node.order,
              skillKey: node.skillKey,
              versionConstraint: node.versionConstraint ?? null,
              conditionExpression: node.conditionExpression ?? null,
              onFailure: node.onFailure ?? "STOP",
              timeoutMs: node.timeoutMs ?? null,
              maxRetries: node.maxRetries ?? 0,
              inputMappingJson: {
                useTriggerInput: node.useTriggerInput ?? false,
                staticInput: node.staticInput ?? {}
              } as Prisma.InputJsonValue
            }))
        }
      },
      include: { nodes: { orderBy: { order: "asc" } } }
    });

    this.auditLogger?.record("SKILL_PIPELINE_CREATED", requestId ?? "skill-pipeline-create", {
      organizationId,
      userId,
      pipelineId: pipeline.id,
      nodeCount: input.nodes.length
    });
    return pipeline;
  }

  async listPipelines(organizationId: string) {
    return this.prisma.skillPipeline.findMany({
      where: { organizationId, deletedAt: null },
      include: { nodes: { orderBy: { order: "asc" } }, _count: { select: { executions: true } } },
      orderBy: { createdAt: "desc" }
    });
  }

  async getPipeline(organizationId: string, pipelineId: string) {
    const pipeline = await this.prisma.skillPipeline.findFirst({
      where: { id: pipelineId, organizationId, deletedAt: null },
      include: { nodes: { orderBy: { order: "asc" } } }
    });
    if (!pipeline) throw new SkillError("SKILL_PIPELINE_NOT_FOUND");
    return pipeline;
  }

  async deletePipeline(organizationId: string, userId: string, pipelineId: string, requestId?: string) {
    await this.getPipeline(organizationId, pipelineId);
    await this.prisma.skillPipeline.updateMany({
      where: { id: pipelineId, organizationId },
      data: { deletedAt: new Date(), isActive: false }
    });
    this.auditLogger?.record("SKILL_PIPELINE_DELETED", requestId ?? "skill-pipeline-delete", {
      organizationId,
      userId,
      pipelineId
    });
    return { deleted: true, pipelineId };
  }

  // ------------------------------------------------------------------ execution

  async execute(
    organizationId: string,
    userId: string,
    pipelineId: string,
    input: ExecuteSkillPipelineInput,
    traceContext?: TraceContext | null,
    requestId?: string
  ) {
    const pipeline = await this.getPipeline(organizationId, pipelineId);
    if (!pipeline.isActive) throw new SkillError("SKILL_INSTALLATION_STATE_CONFLICT", "Pipeline is not active");

    return this.traced(traceContext, organizationId, pipeline.name, async (span) => {
      const execution = await this.prisma.skillPipelineExecution.create({
        data: {
          organizationId,
          skillPipelineId: pipeline.id,
          pluginInstallationId: input.pluginInstallationId ?? null,
          traceId: span?.traceId ?? traceContext?.traceId ?? null,
          triggerInputJson: (input.input ?? {}) as Prisma.InputJsonValue,
          status: "RUNNING"
        }
      });

      const started = Date.now();
      let previousOutput: unknown = input.input;
      let stoppedEarly = false;
      let anyFailed = false;

      for (const node of pipeline.nodes) {
        if (stoppedEarly) {
          await this.prisma.skillPipelineNodeExecution.create({
            data: {
              skillPipelineExecutionId: execution.id,
              skillPipelineNodeId: node.id,
              order: node.order,
              skillKey: node.skillKey,
              status: "SKIPPED"
            }
          });
          continue;
        }

        const condition = evaluateCondition(node.conditionExpression, { output: previousOutput, trigger: input.input });
        if (!condition.matched) {
          await this.prisma.skillPipelineNodeExecution.create({
            data: {
              skillPipelineExecutionId: execution.id,
              skillPipelineNodeId: node.id,
              order: node.order,
              skillKey: node.skillKey,
              status: "SKIPPED"
            }
          });
          continue;
        }

        const nodeInput = this.resolveNodeInput(node, previousOutput, input.input);

        const nodeStarted = Date.now();
        let nodeExecution = await this.prisma.skillPipelineNodeExecution.create({
          data: {
            skillPipelineExecutionId: execution.id,
            skillPipelineNodeId: node.id,
            order: node.order,
            skillKey: node.skillKey,
            status: "RUNNING",
            startedAt: new Date()
          }
        });

        try {
          const result = await this.executeNodeWithRetry(node, nodeInput, {
            organizationId,
            userId,
            ...(input.pluginInstallationId ? { pluginInstallationId: input.pluginInstallationId } : {}),
            ...(input.conversationId ? { conversationId: input.conversationId } : {}),
            ...(input.workflowExecutionId ? { workflowExecutionId: input.workflowExecutionId } : {}),
            traceContext: span ?? traceContext ?? null,
            ...(requestId ? { requestId } : {}),
            idempotencyKeyPrefix: input.idempotencyKeyPrefix ?? execution.id
          });

          nodeExecution = await this.prisma.skillPipelineNodeExecution.update({
            where: { id: nodeExecution.id },
            data: {
              status: "COMPLETED",
              skillRunId: result.runId,
              retryCount: result.retryCount,
              completedAt: new Date(),
              durationMs: Date.now() - nodeStarted
            }
          });
          previousOutput = result.data;
        } catch (error) {
          const skillError = error instanceof SkillError ? error : new SkillError("SKILL_INTERNAL_ERROR", errorMessage(error));
          await this.prisma.skillPipelineNodeExecution.update({
            where: { id: nodeExecution.id },
            data: {
              status: "FAILED",
              errorCode: skillError.code,
              errorMessageSafe: skillError.message.slice(0, 500),
              completedAt: new Date(),
              durationMs: Date.now() - nodeStarted
            }
          });
          anyFailed = true;
          if (node.onFailure === "STOP") stoppedEarly = true;
        }
      }

      const status = stoppedEarly ? "FAILED" : anyFailed ? "PARTIAL" : "COMPLETED";
      await this.prisma.skillPipelineExecution.update({
        where: { id: execution.id },
        data: { status, completedAt: new Date(), durationMs: Date.now() - started }
      });

      this.auditLogger?.record("SKILL_PIPELINE_EXECUTED", requestId ?? "skill-pipeline-execute", {
        organizationId,
        userId,
        pipelineId: pipeline.id,
        executionId: execution.id,
        status
      });

      return this.getExecution(organizationId, execution.id);
    });
  }

  async listExecutions(organizationId: string, pipelineId: string, page: { page: number; pageSize: number }) {
    const where: Prisma.SkillPipelineExecutionWhereInput = { organizationId, skillPipelineId: pipelineId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.skillPipelineExecution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.skillPipelineExecution.count({ where })
    ]);
    return { items, total };
  }

  /** The execution graph (DAG) a dashboard renders: node status/timing/output-linkage for one run. */
  async getExecution(organizationId: string, executionId: string) {
    const execution = await this.prisma.skillPipelineExecution.findFirst({
      where: { id: executionId, organizationId },
      include: {
        nodeExecutions: { orderBy: { order: "asc" } },
        skillPipeline: { select: { id: true, name: true } }
      }
    });
    if (!execution) throw new SkillError("SKILL_PIPELINE_EXECUTION_NOT_FOUND");
    return execution;
  }

  // ------------------------------------------------------------------ helpers

  /** Chains the previous node's output into this node's input. Real skills declare strict
   *  (`additionalProperties: false`) input schemas that rarely match a prior skill's output shape
   *  1:1 — so the base value (previous output, or the pipeline's trigger input when
   *  `useTriggerInput` is set) is filtered down to only the keys this node's manifest actually
   *  declares (schema-driven, never a per-skill-pair hardcoded mapping), then the node's own
   *  `staticInput` is merged on top for parameters no prior output could ever supply (e.g.
   *  entity-extraction's `entitySchema`, translation's `targetLanguage`). */
  private resolveNodeInput(node: { skillKey: string; inputMappingJson: unknown }, previousOutput: unknown, triggerInput: unknown): unknown {
    const mapping = readInputMapping(node.inputMappingJson);
    const base = mapping.useTriggerInput ? triggerInput : previousOutput;
    const manifest = this.registry.manifest(node.skillKey);
    const filtered = filterToSchemaKeys(base, manifest?.inputSchema);
    if (!isPlainObject(filtered)) return Object.keys(mapping.staticInput).length > 0 ? mapping.staticInput : filtered;
    return { ...filtered, ...mapping.staticInput };
  }

  private async executeNodeWithRetry(
    node: { skillKey: string; versionConstraint: string | null; timeoutMs: number | null; maxRetries: number },
    nodeInput: unknown,
    refs: {
      organizationId: string;
      userId: string;
      pluginInstallationId?: string;
      conversationId?: string;
      workflowExecutionId?: string;
      traceContext: TraceContext | null;
      requestId?: string;
      idempotencyKeyPrefix: string;
    }
  ) {
    let attempt = 0;
    for (;;) {
      try {
        const call = this.runtime.execute({
          skillKey: node.skillKey,
          ...(node.versionConstraint ? { versionConstraint: node.versionConstraint } : {}),
          organizationId: refs.organizationId,
          userId: refs.userId,
          input: nodeInput,
          ...(refs.pluginInstallationId ? { pluginInstallationId: refs.pluginInstallationId } : {}),
          ...(refs.conversationId ? { conversationId: refs.conversationId } : {}),
          ...(refs.workflowExecutionId ? { workflowExecutionId: refs.workflowExecutionId } : {}),
          traceContext: refs.traceContext,
          ...(refs.requestId ? { requestId: refs.requestId } : {}),
          idempotencyKey: `${refs.idempotencyKeyPrefix}:${node.skillKey}:${attempt}`
        });
        return node.timeoutMs ? await withTimeout(call, node.timeoutMs) : await call;
      } catch (error) {
        if (attempt >= node.maxRetries) throw error;
        attempt += 1;
        this.logger.warn({ event: "SKILL_PIPELINE_NODE_RETRY", skillKey: node.skillKey, attempt });
        await sleep(NODE_RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  private async traced<T>(
    context: TraceContext | null | undefined,
    organizationId: string,
    pipelineName: string,
    callback: (span: TraceContext | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.observability) return callback(context ?? undefined);
    return this.observability.withSpan(
      context,
      {
        name: `SKILL_PIPELINE_EXECUTION:${pipelineName}`,
        spanType: "BACKGROUND_TASK",
        component: "SkillPipelineService",
        organizationId
      },
      callback
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Pipeline node execution failed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInputMapping(value: unknown): { useTriggerInput: boolean; staticInput: Record<string, unknown> } {
  if (!isPlainObject(value)) return { useTriggerInput: false, staticInput: {} };
  return {
    useTriggerInput: value.useTriggerInput === true,
    staticInput: isPlainObject(value.staticInput) ? value.staticInput : {}
  };
}

/** Filters `value` down to only the keys `schema.properties` declares, when the schema is strict
 *  (`additionalProperties: false`). Manifest-driven and generic — never a per-skill-pair mapping. */
function filterToSchemaKeys(value: unknown, schema: Record<string, unknown> | undefined): unknown {
  if (!isPlainObject(value) || !schema) return value;
  if (schema.additionalProperties !== false) return value;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return value;
  const allowedKeys = new Set(Object.keys(properties));
  const filtered: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (allowedKeys.has(key)) filtered[key] = entry;
  return filtered;
}
