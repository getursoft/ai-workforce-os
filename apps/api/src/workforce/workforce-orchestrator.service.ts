import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { AgentService } from "../agents/agent.service";
import { ApprovalService } from "../approval/approval.service";
import { MemoryService } from "../memory/memory.service";
import { WorkflowExecutionService } from "../workflows/workflow-execution.service";
import { EmployeeRegistry, type WorkforceEmployee } from "./employee-registry";
import { EmployeeCollaborationRouter, type DelegationRoutingResult } from "./employee-collaboration-router";
import { DelegationContractValidator, type DelegationContract } from "./delegation-contract";
import { WorkforceCollaborationPolicyService } from "./workforce-collaboration-policy.service";
import { WorkforceEventBus, type ApprovalDecidedEvent } from "./workforce-event-bus";
import { ObservabilityService } from "../observability/observability.service";
import { rootedContext, type TraceContext } from "../observability/trace-context";

export interface DelegateInput {
  organizationId: string;
  sourceEmployeeInstallationId: string;
  contract: unknown;
  requestedByActorType?: string;
  requestedByActorId?: string | null;
  parentExecutionId?: string | null;
  parentTaskId?: string | null;
  /** Explicit target override — when omitted, EmployeeCollaborationRouter selects one. */
  targetEmployeeInstallationId?: string | null;
  mode?: "SYNCHRONOUS" | "ASYNCHRONOUS";
  idempotencyKey?: string | null;
  /** Parallel-group internals — set only by delegateParallel(), never by a direct top-level caller. */
  correlationId?: string;
  joinPolicy?: string | null;
  /** Sprint 4.7: the caller's active trace — when omitted, delegate() starts a new trace of its own. */
  traceContext?: TraceContext | null;
}

export interface DelegationPlan {
  contract: DelegationContract;
  routing: DelegationRoutingResult;
  source: WorkforceEmployee;
  target: WorkforceEmployee;
  parentDepth: number;
  parentChain: string[];
  correlationId: string;
}

export interface DelegatedTaskView {
  id: string;
  organizationId: string;
  sourceEmployeeInstallationId: string;
  targetEmployeeInstallationId: string;
  taskType: string;
  title: string;
  status: string;
  mode: string;
  priority: number;
  correlationId: string;
  delegationDepth: number;
  attemptCount: number;
  maxAttempts: number;
  resultSummary: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  parentWorkflowExecutionId: string | null;
}

export interface ParallelDelegateInput {
  organizationId: string;
  sourceEmployeeInstallationId: string;
  requests: Array<{ contract: unknown; targetEmployeeInstallationId?: string }>;
  joinPolicy: "ALL_REQUIRED" | "ANY_ONE" | "MINIMUM_N" | "BEST_EFFORT";
  minimumRequired?: number;
  requestedByActorType?: string;
  requestedByActorId?: string | null;
  mode?: "SYNCHRONOUS" | "ASYNCHRONOUS";
  parentWorkflowExecutionId?: string | null;
  traceContext?: TraceContext | null;
}

export interface JoinView {
  correlationId: string;
  joinPolicy: string;
  status: string;
  resolvedReason: string | null;
  totalChildren: number;
  minimumRequired: number | null;
  succeededCount: number;
  terminalCount: number;
  tasks: DelegatedTaskView[];
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "REJECTED"]);
/** Memory categories/scopes never leave the source employee by default — Phase 8/9 least privilege. */
const NEVER_SHARED_IMPORTANCE = new Set(["CRITICAL"]);
const SHARED_CONTEXT_TTL_MS = 60 * 60 * 1000; // temporary collaboration context expires after 1 hour

@Injectable()
export class WorkforceOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(WorkforceOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EmployeeRegistry,
    private readonly router: EmployeeCollaborationRouter,
    private readonly contractValidator: DelegationContractValidator,
    private readonly policyService: WorkforceCollaborationPolicyService,
    private readonly agentService: AgentService,
    private readonly approvalService: ApprovalService,
    private readonly memoryService: MemoryService,
    private readonly workflows: WorkflowExecutionService,
    private readonly events: WorkforceEventBus,
    private readonly audit: AuditEventLogger,
    private readonly observability: ObservabilityService
  ) {}

  /** Push-based approval resumption: subscribes once, for the lifetime of this singleton service, to
   *  every approval decision made anywhere in the app. Filters down to decisions on delegated tasks by
   *  approvalRequestId — every other approval (e.g. a travel booking) is ignored here. This is the
   *  PRIMARY resume mechanism; syncFromApproval()/getTask()'s poll-on-read is now only a defensive
   *  fallback for an event missed across a process restart. */
  onModuleInit(): void {
    this.events.onApprovalDecided((event) => {
      this.handleApprovalDecided(event).catch((error) => {
        this.logger.error({ event: "WorkforceApprovalPushHandlerFailed", error: String(error) });
      });
    });
  }

  private async handleApprovalDecided(event: ApprovalDecidedEvent): Promise<void> {
    const task = await this.prisma.employeeDelegatedTask.findFirst({
      where: { approvalRequestId: event.approvalRequestId, organizationId: event.organizationId }
    });
    if (!task || task.status !== "WAITING_FOR_APPROVAL") return;
    this.logger.log({ event: "WorkforceApprovalPushReceived", taskId: task.id, decision: event.decision });
    if (event.decision === "APPROVED") {
      await this.dispatch(task.id);
      return;
    }
    if (["REJECTED", "CANCELLED", "EXPIRED"].includes(event.decision)) {
      await this.failTask(task.id, "DELEGATION_NOT_ALLOWED", "The delegated task's approval was rejected.");
    }
  }

  // ---------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------

  /** Validates the contract, resolves a target through the router, and enforces every policy/security
   *  boundary — but does not persist or execute anything. Throws a stable-coded IdentityApplicationError
   *  on any rejection (Phase 18 error codes). */
  async planDelegation(input: DelegateInput): Promise<DelegationPlan> {
    const contract = this.contractValidator.validate(input.contract);

    const policy = await this.policyService.getOrCreate(input.organizationId);
    if (!policy.collaborationEnabled) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "Collaboration is disabled for this organization.");
    }
    if (policy.allowedTaskTypes.length > 0 && !policy.allowedTaskTypes.includes(contract.taskType)) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "This task type is not allowed by organization policy.");
    }
    if (policy.allowedSourceEmployeeIds.length > 0 && !policy.allowedSourceEmployeeIds.includes(input.sourceEmployeeInstallationId)) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "This employee is not allowed to delegate work.");
    }

    const source = await this.registry.getInstalled(input.organizationId, input.sourceEmployeeInstallationId);
    if (!source) {
      throw new IdentityApplicationError(
        "WORKFORCE_EMPLOYEE_NOT_INSTALLED",
        "The delegating employee is not installed in this organization."
      );
    }
    if (source.status !== "ACTIVE") {
      throw new IdentityApplicationError("WORKFORCE_TARGET_DISABLED", "The delegating employee is not active.");
    }

    // --- Cycle / depth resolution from the parent task, if this is a nested delegation ---
    const parent = input.parentTaskId
      ? await this.prisma.employeeDelegatedTask.findFirst({
          where: { id: input.parentTaskId, organizationId: input.organizationId }
        })
      : null;
    if (input.parentTaskId && !parent) {
      throw new IdentityApplicationError("PARENT_EXECUTION_CLOSED", "The parent delegated task could not be found.");
    }
    const parentChain: string[] = parent ? (parent.delegationChain as string[]) : [];
    const parentDepth = parent?.delegationDepth ?? 0;
    const nextDepth = parentDepth + 1;
    if (nextDepth > policy.maximumDelegationDepth) {
      throw new IdentityApplicationError(
        "DELEGATION_DEPTH_EXCEEDED",
        `Delegation depth ${nextDepth} exceeds the organization's maximum of ${policy.maximumDelegationDepth}.`
      );
    }

    // --- Routing ---
    const routing = await this.router.route(input.organizationId, input.sourceEmployeeInstallationId, contract, {
      ...(policy.allowedTargetEmployeeIds.length > 0 ? { allowedTargetEmployeeIds: policy.allowedTargetEmployeeIds } : {})
    });
    await this.audit.record("WORKFORCE_DELEGATION_PLANNED", input.requestedByActorId ?? randomUUID(), {
      organizationId: input.organizationId,
      sourceEmployeeInstallationId: input.sourceEmployeeInstallationId,
      taskType: contract.taskType,
      reasonCode: routing.reasonCode,
      confidence: routing.confidence
    });

    const targetId = input.targetEmployeeInstallationId ?? routing.targetEmployeeInstallationId;
    if (!routing.shouldDelegate && !input.targetEmployeeInstallationId) {
      throw new IdentityApplicationError(
        "NO_ELIGIBLE_EMPLOYEE",
        "No installed, capable employee is available to handle this task.",
        [`reasonCode=${routing.reasonCode}`]
      );
    }
    if (!targetId) {
      throw new IdentityApplicationError("NO_ELIGIBLE_EMPLOYEE", "No installed, capable employee is available to handle this task.");
    }

    // --- Cycle detection: the resolved target must not already be in the delegation chain ---
    const chainWithSource = [...parentChain, input.sourceEmployeeInstallationId];
    if (chainWithSource.includes(targetId)) {
      throw new IdentityApplicationError(
        "DELEGATION_CYCLE_DETECTED",
        "This delegation would create a cycle in the collaboration chain.",
        [`chain=${[...chainWithSource, targetId].join(" -> ")}`]
      );
    }

    const target = await this.registry.getInstalled(input.organizationId, targetId);
    if (!target) {
      throw new IdentityApplicationError(
        "WORKFORCE_EMPLOYEE_NOT_INSTALLED",
        "The target employee is not installed in this organization."
      );
    }
    if (target.status !== "ACTIVE") {
      throw new IdentityApplicationError("WORKFORCE_TARGET_DISABLED", "The target employee is disabled.");
    }
    if (!target.collaboration.enabled) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "The target employee has collaboration disabled.");
    }

    // --- Confused-deputy guard: the target must hold its OWN required capabilities. The source's
    // privileges are never inherited — this check runs against the target's own registry entry only. ---
    const missingBase = target.collaboration.requiredCapabilities.filter(
      (cap) => !target.grantedPermissions.includes(cap) && !target.capabilities.includes(cap)
    );
    if (missingBase.length > 0) {
      throw new IdentityApplicationError(
        "WORKFORCE_CAPABILITY_NOT_GRANTED",
        "The target employee is missing a capability required to accept delegated work.",
        missingBase.map((cap) => `missing: ${cap}`)
      );
    }
    if (contract.targetCapability) {
      const has =
        target.capabilities.includes(contract.targetCapability) ||
        target.grantedPermissions.includes(contract.targetCapability) ||
        target.employeeType === contract.targetCapability;
      if (!has) {
        throw new IdentityApplicationError(
          "WORKFORCE_CAPABILITY_NOT_GRANTED",
          `The target employee does not have the requested capability: ${contract.targetCapability}.`
        );
      }
    }

    return {
      contract,
      routing,
      source,
      target,
      parentDepth: nextDepth,
      parentChain: chainWithSource,
      correlationId: input.correlationId ?? parent?.correlationId ?? randomUUID()
    };
  }

  // ---------------------------------------------------------------------
  // Delegation lifecycle
  // ---------------------------------------------------------------------

  async delegate(input: DelegateInput): Promise<DelegatedTaskView> {
    return this.observability.withSpan(
      input.traceContext,
      {
        name: "DELEGATION",
        spanType: "DELEGATION",
        component: "WorkforceOrchestratorService",
        organizationId: input.organizationId,
        actorType: input.requestedByActorType ?? "EMPLOYEE",
        actorId: input.requestedByActorId ?? null,
        employeeInstallationId: input.sourceEmployeeInstallationId,
        inputSummary: { sourceEmployeeInstallationId: input.sourceEmployeeInstallationId, targetEmployeeInstallationId: input.targetEmployeeInstallationId ?? null, mode: input.mode ?? null }
      },
      async (span) => this.delegateTraced(input, span)
    );
  }

  private async delegateTraced(input: DelegateInput, span: TraceContext): Promise<DelegatedTaskView> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.employeeDelegatedTask.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });
      if (existing && existing.organizationId === input.organizationId) return this.toView(existing);
    }

    const plan = await this.planDelegation(input);
    const requiresApproval = Boolean(plan.contract.constraints?.requiresApproval);
    const mode: "SYNCHRONOUS" | "ASYNCHRONOUS" =
      input.mode ?? (plan.target.collaboration.supportsSynchronous ? "SYNCHRONOUS" : "ASYNCHRONOUS");

    // Least-privilege shared context: only ever the categories the SOURCE explicitly asked to share,
    // filtered by tenant/employee/sensitivity/policy — never the full conversation or full memory store.
    const shared = await this.buildSharedMemoryContext(
      input.organizationId,
      plan.source.installationId,
      readRequestedMemoryCategories(plan.contract)
    );

    // Every delegated task gets a real Conversation up front (not just once dispatch runs) so an
    // ASYNCHRONOUS task already has somewhere durable to attach its own WorkflowExecution before it has
    // actually executed.
    const conversation = await this.prisma.conversation.create({
      data: {
        organizationId: input.organizationId,
        pluginInstallationId: plan.target.installationId,
        title: `Delegated: ${plan.contract.objective}`.slice(0, 160),
        metadata: { delegatedFrom: plan.source.installationId }
      }
    });

    const task = await this.prisma.employeeDelegatedTask.create({
      data: {
        organizationId: input.organizationId,
        parentExecutionId: input.parentExecutionId ?? null,
        parentWorkflowExecutionId: null,
        sourceEmployeeInstallationId: input.sourceEmployeeInstallationId,
        targetEmployeeInstallationId: plan.target.installationId,
        childConversationId: conversation.id,
        requestedByActorType: input.requestedByActorType ?? "EMPLOYEE",
        requestedByActorId: input.requestedByActorId ?? null,
        taskType: plan.contract.taskType,
        title: plan.contract.objective.slice(0, 300),
        instructions: renderInstructions(plan, shared.lines),
        inputPayloadJson: plan.contract.input as object,
        expectedOutputSchemaJson: (plan.contract.expectedOutput as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        status: "QUEUED",
        priority: 0,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: plan.correlationId,
        causationId: input.parentTaskId ?? null,
        delegationDepth: plan.parentDepth,
        delegationChain: plan.parentChain,
        joinPolicy: input.joinPolicy ?? null,
        mode,
        maxAttempts: requiresApproval ? 1 : 2,
        timeoutAt: new Date(Date.now() + (plan.contract.constraints?.timeoutMs ?? 15_000)),
        traceId: span.sampled ? span.traceId : null
      }
    });

    await this.audit.record("WORKFORCE_TASK_CREATED", input.requestedByActorId ?? task.id, {
      organizationId: input.organizationId,
      taskId: task.id,
      sourceEmployeeInstallationId: input.sourceEmployeeInstallationId,
      targetEmployeeInstallationId: plan.target.installationId,
      taskType: plan.contract.taskType,
      correlationId: plan.correlationId
    });

    if (shared.sharedFacts.length > 0) {
      await this.persistTemporaryCollaborationContext(input.organizationId, plan.target.installationId, task.id, shared.sharedFacts);
    }

    if (requiresApproval) {
      return this.dispatchWithApproval(task.id, plan);
    }

    if (mode === "ASYNCHRONOUS") {
      // Real asynchronous delegation: persist QUEUED and durably track it via the same
      // WorkflowExecutionService every other workflow type in this codebase uses (optimistic locking,
      // idempotent turns, crash-recoverable state) — then return immediately. Execution happens later,
      // outside this HTTP request, when WorkforceTaskProcessor's independent polling tick picks it up.
      const { execution } = await this.workflows.createWorkflow({
        scope: {
          organizationId: input.organizationId,
          pluginInstallationId: plan.target.installationId,
          conversationId: conversation.id,
          workflowType: "EMPLOYEE_DELEGATION"
        },
        currentStep: "QUEUED",
        pendingInput: null,
        state: { delegatedTaskId: task.id, taskType: plan.contract.taskType },
        turnId: `${task.id}:queued`
      });
      const queued = await this.prisma.employeeDelegatedTask.update({
        where: { id: task.id },
        data: { parentWorkflowExecutionId: execution.id }
      });
      await this.audit.record("WORKFORCE_TASK_QUEUED_ASYNC", task.id, {
        organizationId: input.organizationId,
        taskId: task.id,
        workflowExecutionId: execution.id
      });
      return this.toView(queued);
    }

    return this.dispatch(task.id);
  }

  /** Creates N sibling tasks under one shared correlationId and a persisted EmployeeDelegationJoin row —
   *  Phase 11 parallel collaboration. Each sibling goes through the exact same delegate()/dispatch() path
   *  as a standalone delegation (same security, same routing, same execution) — parallelism here means
   *  "many concurrently in-flight children", not a second execution mechanism. */
  async delegateParallel(input: ParallelDelegateInput): Promise<JoinView> {
    return this.observability.withSpan(
      input.traceContext,
      {
        name: "PARALLEL_JOIN",
        spanType: "PARALLEL_JOIN",
        component: "WorkforceOrchestratorService",
        organizationId: input.organizationId,
        employeeInstallationId: input.sourceEmployeeInstallationId,
        inputSummary: { joinPolicy: input.joinPolicy, totalChildren: input.requests.length }
      },
      async (span) => this.delegateParallelTraced(input, span)
    );
  }

  private async delegateParallelTraced(input: ParallelDelegateInput, span: TraceContext): Promise<JoinView> {
    if (input.requests.length === 0) {
      throw new IdentityApplicationError("TASK_SCHEMA_INVALID", "A parallel delegation requires at least one request.");
    }
    const policy = await this.policyService.getOrCreate(input.organizationId);
    if (!policy.allowParallelDelegation) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "Parallel delegation is disabled for this organization.");
    }
    if (input.joinPolicy === "MINIMUM_N" && !input.minimumRequired) {
      throw new IdentityApplicationError("TASK_SCHEMA_INVALID", "MINIMUM_N requires minimumRequired.");
    }

    const correlationId = randomUUID();
    await this.prisma.employeeDelegationJoin.create({
      data: {
        organizationId: input.organizationId,
        correlationId,
        sourceEmployeeInstallationId: input.sourceEmployeeInstallationId,
        parentWorkflowExecutionId: input.parentWorkflowExecutionId ?? null,
        joinPolicy: input.joinPolicy,
        minimumRequired: input.minimumRequired ?? null,
        totalChildren: input.requests.length,
        status: "PENDING"
      }
    });
    await this.audit.record("WORKFORCE_PARALLEL_GROUP_CREATED", correlationId, {
      organizationId: input.organizationId,
      correlationId,
      joinPolicy: input.joinPolicy,
      totalChildren: input.requests.length
    });

    const dispatches = input.requests.map((request) =>
      this.delegate({
        organizationId: input.organizationId,
        sourceEmployeeInstallationId: input.sourceEmployeeInstallationId,
        contract: request.contract,
        ...(request.targetEmployeeInstallationId ? { targetEmployeeInstallationId: request.targetEmployeeInstallationId } : {}),
        requestedByActorType: input.requestedByActorType ?? "EMPLOYEE",
        requestedByActorId: input.requestedByActorId ?? null,
        mode: input.mode ?? "SYNCHRONOUS",
        correlationId,
        joinPolicy: input.joinPolicy,
        traceContext: span
      }).catch((error) => {
        // A single sibling failing to even PLAN (e.g. NO_ELIGIBLE_EMPLOYEE) must not corrupt the group —
        // it still counts as a terminal (failed) member once we synthesize its absence below.
        this.logger.warn({ event: "WorkforceParallelChildPlanFailed", correlationId, error: String(error) });
        return null;
      })
    );
    await Promise.all(dispatches);
    // Every child that failed to even be created (planning threw before a row existed) leaves the group
    // permanently short of totalChildren — reconcile immediately so a policy like ALL_REQUIRED can still
    // resolve (as a failure) instead of waiting forever for a row that will never exist.
    await this.evaluateJoin(correlationId);

    const view = await this.getJoin(input.organizationId, correlationId);
    if (!view) throw new IdentityApplicationError("INTERNAL_ERROR", "The parallel join could not be loaded after creation.");
    return view;
  }

  /** Atomically resolves a parallel join at most once, evaluating the configured policy against its
   *  siblings' current terminal/success counts. Safe to call redundantly after every child transition —
   *  a no-op once the group is already RESOLVED or not yet eligible. */
  private async evaluateJoin(correlationId: string): Promise<void> {
    const join = await this.prisma.employeeDelegationJoin.findUnique({ where: { correlationId } });
    if (!join || join.status !== "PENDING") return;

    const siblings = await this.prisma.employeeDelegatedTask.findMany({ where: { correlationId } });
    const terminalCount = siblings.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
    const succeededCount = siblings.filter((task) => task.status === "COMPLETED").length;
    const pendingCount = join.totalChildren - terminalCount;

    let resolvedReason: string | null = null;
    switch (join.joinPolicy) {
      case "ALL_REQUIRED":
        if (terminalCount >= join.totalChildren) resolvedReason = succeededCount === join.totalChildren ? "ALL_SUCCEEDED" : "PARTIAL_FAILURE";
        break;
      case "ANY_ONE":
        if (succeededCount >= 1) resolvedReason = "FIRST_SUCCESS";
        else if (terminalCount >= join.totalChildren) resolvedReason = "ALL_FAILED";
        break;
      case "MINIMUM_N": {
        const minimum = join.minimumRequired ?? join.totalChildren;
        if (succeededCount >= minimum) resolvedReason = "MINIMUM_REACHED";
        else if (succeededCount + pendingCount < minimum) resolvedReason = "MINIMUM_UNREACHABLE";
        break;
      }
      case "BEST_EFFORT":
        if (terminalCount >= join.totalChildren) resolvedReason = succeededCount > 0 ? "BEST_EFFORT_PARTIAL" : "BEST_EFFORT_NONE";
        break;
      default:
        break;
    }
    if (!resolvedReason) return;

    // The atomic claim: only one concurrent evaluateJoin() call (however many siblings finished at once)
    // ever wins this update — everyone else's `count` comes back 0 and they skip the resume side effect,
    // which is exactly what "prevent duplicate parent resume" requires.
    const claim = await this.prisma.employeeDelegationJoin.updateMany({
      where: { id: join.id, status: "PENDING" },
      data: { status: "RESOLVED", resolvedReason, resolvedAt: new Date() }
    });
    if (claim.count !== 1) return;

    await this.audit.record("WORKFORCE_PARALLEL_GROUP_RESOLVED", correlationId, {
      organizationId: join.organizationId,
      correlationId,
      resolvedReason,
      succeededCount,
      totalChildren: join.totalChildren
    });

    if (join.parentWorkflowExecutionId) {
      const workflow = await this.workflows.loadWorkflow(join.organizationId, join.parentWorkflowExecutionId);
      if (workflow) {
        const succeeded = resolvedReason !== "ALL_FAILED" && resolvedReason !== "MINIMUM_UNREACHABLE" && resolvedReason !== "BEST_EFFORT_NONE";
        await (succeeded
          ? this.workflows.markCompleted({
              organizationId: join.organizationId,
              id: workflow.id,
              expectedRevision: workflow.revision,
              state: { ...(workflow.state as Record<string, unknown>), joinResolvedReason: resolvedReason },
              currentStep: "PARALLEL_DELEGATION_RESOLVED"
            })
          : this.workflows.markFailed({
              organizationId: join.organizationId,
              id: workflow.id,
              expectedRevision: workflow.revision,
              state: { ...(workflow.state as Record<string, unknown>), joinResolvedReason: resolvedReason },
              currentStep: "PARALLEL_DELEGATION_FAILED"
            }));
      }
    }
  }

  async getJoin(organizationId: string, correlationId: string): Promise<JoinView | null> {
    const join = await this.prisma.employeeDelegationJoin.findFirst({ where: { organizationId, correlationId } });
    if (!join) return null;
    const tasks = await this.listTasks(organizationId, { correlationId });
    return {
      correlationId: join.correlationId,
      joinPolicy: join.joinPolicy,
      status: join.status,
      resolvedReason: join.resolvedReason,
      totalChildren: join.totalChildren,
      minimumRequired: join.minimumRequired,
      succeededCount: tasks.filter((task) => task.status === "COMPLETED").length,
      terminalCount: tasks.filter((task) => TERMINAL_STATUSES.has(task.status)).length,
      tasks
    };
  }

  /** Executes a QUEUED task against its target employee via the existing agent execution pipeline —
   *  reusing AgentService.execute() means the target runs under its OWN capability grants, tool
   *  permissions, and AI provider configuration, exactly as if a user had messaged it directly. Called
   *  inline for SYNCHRONOUS tasks, and later (outside the original HTTP request) by WorkforceTaskProcessor
   *  for ASYNCHRONOUS ones. */
  async dispatch(taskId: string): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") {
      return this.toView(task);
    }
    if (task.timeoutAt && task.timeoutAt.getTime() < Date.now()) {
      return this.failTask(taskId, "TASK_TIMED_OUT", "The delegated task timed out before it could run.");
    }

    await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: { status: "RUNNING", startedAt: task.startedAt ?? new Date(), attemptCount: { increment: 1 } }
    });
    await this.audit.record("WORKFORCE_TASK_DISPATCHED", taskId, {
      organizationId: task.organizationId,
      taskId,
      targetEmployeeInstallationId: task.targetEmployeeInstallationId
    });

    // Rebuilt from the task row rather than threaded through the call stack: dispatch() may run in this
    // same request (synchronous delegation) or much later, on a totally different call stack, when
    // WorkforceTaskProcessor's background timer picks up a QUEUED task — either way the child's
    // AGENT_EXECUTION span still attaches to the SAME trace the original request started (Phase 2: "async
    // execution must preserve the original traceId").
    const dispatchTraceContext = task.traceId
      ? rootedContext(task.organizationId, task.traceId, true, { delegatedTaskId: task.id })
      : undefined;

    const knownCustomerName = delegatedCustomerName(task.inputPayloadJson);
    try {
      const result = await this.agentService.execute({
        organizationId: task.organizationId,
        agentId: task.targetEmployeeInstallationId,
        ...(task.childConversationId ? { conversationId: task.childConversationId } : {}),
        actor: { type: "SYSTEM", sourceEmployeeInstallationId: task.sourceEmployeeInstallationId, delegatedTaskId: task.id },
        text: task.instructions,
        source: { type: "DASHBOARD" },
        requestId: `workforce-${task.id}`,
        metadata: {
          delegatedTaskId: task.id,
          correlationId: task.correlationId,
          ...(knownCustomerName ? { receptionistCustomerName: knownCustomerName } : {})
        },
        ...(dispatchTraceContext ? { traceContext: dispatchTraceContext } : {})
      });

      if (!task.childConversationId) {
        await this.prisma.employeeDelegatedTask.update({
          where: { id: taskId },
          data: { childConversationId: result.conversationId }
        });
      }

      const resultPayload = parseResultPayload(result.response);
      this.contractValidator.validateResult(resultPayload, task.expectedOutputSchemaJson as Record<string, unknown> | null);
      return this.completeTask(taskId, resultPayload);
    } catch (error) {
      if (error instanceof IdentityApplicationError) {
        return this.failTask(taskId, error.code, safeMessage(error.message));
      }
      this.logger.error({ event: "WorkforceTaskExecutionThrew", taskId, error: String(error) });
      return this.failTask(taskId, "TARGET_EXECUTION_FAILED", "The target employee could not complete this task.");
    }
  }

  private async dispatchWithApproval(taskId: string, plan: DelegationPlan): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    const conversationId =
      task.childConversationId ??
      (
        await this.prisma.conversation.create({
          data: {
            organizationId: task.organizationId,
            pluginInstallationId: task.targetEmployeeInstallationId,
            title: `Delegated approval: ${task.title}`.slice(0, 160),
            metadata: { delegatedTaskId: task.id }
          }
        })
      ).id;
    // Goes through WorkflowExecutionService (not a raw prisma.create) so activeKey is set correctly —
    // resumeParent()'s markCompleted/markFailed only ever match rows with a non-null activeKey.
    const { execution: created } = await this.workflows.createWorkflow({
      scope: { organizationId: task.organizationId, pluginInstallationId: task.targetEmployeeInstallationId, conversationId, workflowType: "EMPLOYEE_DELEGATION" },
      currentStep: "APPROVAL_REQUESTED",
      pendingInput: null,
      state: { delegatedTaskId: task.id },
      turnId: `${task.id}:approval-requested`
    });
    const workflow = await this.workflows.updateWorkflowState({
      organizationId: task.organizationId,
      id: created.id,
      expectedRevision: created.revision,
      currentStep: "AWAITING_APPROVAL",
      pendingInput: null,
      state: { delegatedTaskId: task.id },
      turnId: `${task.id}:awaiting-approval`,
      status: "WAITING_FOR_APPROVAL"
    }).then((result) => result.execution);
    const approval = await this.approvalService.create({
      organizationId: task.organizationId,
      workflowExecutionId: workflow.id,
      agentId: task.targetEmployeeInstallationId,
      actionType: `WORKFORCE_DELEGATION_${task.taskType}`,
      requesterType: "EMPLOYEE",
      requestedBy: plan.source.displayName,
      title: task.title,
      description: task.instructions.slice(0, 1900)
    });
    const updated = await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: {
        status: "WAITING_FOR_APPROVAL",
        parentWorkflowExecutionId: workflow.id,
        approvalRequestId: approval.id,
        childConversationId: conversationId
      }
    });
    await this.audit.record("WORKFORCE_APPROVAL_REQUESTED", taskId, {
      organizationId: task.organizationId,
      taskId,
      approvalRequestId: approval.id
    });
    return this.toView(updated);
  }

  /** Fallback reconciliation only (see onModuleInit's push handler for the primary path) — re-checks a
   *  WAITING_FOR_APPROVAL task's linked ApprovalRequest directly, for the rare case an event was emitted
   *  while this process wasn't running to receive it. */
  async syncFromApproval(taskId: string): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status !== "WAITING_FOR_APPROVAL" || !task.approvalRequestId) return this.toView(task);
    const approval = await this.approvalService.findById(task.approvalRequestId, task.organizationId);
    if (!approval) return this.toView(task);
    if (approval.status === "APPROVED") return this.dispatch(taskId);
    if (approval.status === "REJECTED" || approval.status === "CANCELLED") {
      return this.failTask(taskId, "DELEGATION_NOT_ALLOWED", "The delegated task's approval was rejected.");
    }
    return this.toView(task);
  }

  async completeTask(taskId: string, resultPayload: Record<string, unknown>): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status === "COMPLETED") {
      // Duplicate completion — the first completion already resumed the parent; this one is a no-op.
      this.logger.warn({ event: "WorkforceDuplicateCompletionIgnored", taskId });
      return this.toView(task);
    }
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      throw new IdentityApplicationError("WORKFORCE_DUPLICATE_COMPLETION", "This task already reached a terminal state.");
    }
    const updated = await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: { status: "COMPLETED", completedAt: new Date(), resultPayloadJson: resultPayload as object }
    });
    await this.audit.record("WORKFORCE_TASK_COMPLETED", taskId, {
      organizationId: task.organizationId,
      taskId,
      targetEmployeeInstallationId: task.targetEmployeeInstallationId
    });
    await this.resumeParent(taskId);
    await this.evaluateJoin(task.correlationId);
    return this.toView(updated);
  }

  async failTask(taskId: string, errorCode: string, errorMessageSafe: string): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") {
      return this.toView(task);
    }
    const retryableCodes = new Set(["TARGET_EXECUTION_FAILED", "TASK_TIMED_OUT"]);
    if (retryableCodes.has(errorCode) && task.attemptCount < task.maxAttempts) {
      // Both fields must move before recursing into dispatch(): attemptCount bounds the retry loop (a
      // TASK_TIMED_OUT failure caught before dispatch() ever set RUNNING never touches attemptCount on
      // its own), and timeoutAt must be pushed out or a timeout-caused retry would immediately re-expire
      // against the same stale deadline and recurse forever.
      await this.prisma.employeeDelegatedTask.update({
        where: { id: taskId },
        data: { attemptCount: { increment: 1 }, timeoutAt: new Date(Date.now() + 15_000) }
      });
      await this.audit.record("WORKFORCE_TASK_RETRY_SCHEDULED", taskId, {
        organizationId: task.organizationId,
        taskId,
        attemptCount: task.attemptCount + 1
      });
      return this.dispatch(taskId);
    }
    const status = errorCode === "TASK_TIMED_OUT" ? "TIMED_OUT" : "FAILED";
    const updated = await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: {
        status,
        failedAt: new Date(),
        errorCode,
        errorMessageSafe: errorMessageSafe.slice(0, 500)
      }
    });
    await this.audit.record("WORKFORCE_TASK_FAILED", taskId, {
      organizationId: task.organizationId,
      taskId,
      errorCode
    });
    await this.resumeParent(taskId);
    await this.evaluateJoin(task.correlationId);
    return this.toView(updated);
  }

  async cancelTask(organizationId: string, taskId: string): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findFirstOrThrow({ where: { id: taskId, organizationId } });
    if (task.status === "COMPLETED" || task.status === "FAILED" || task.status === "CANCELLED") {
      return this.toView(task);
    }
    const updated = await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: { status: "CANCELLED", cancelledAt: new Date() }
    });
    await this.audit.record("WORKFORCE_TASK_CANCELLED", taskId, { organizationId, taskId });
    if (task.parentWorkflowExecutionId) {
      const workflow = await this.workflows.loadWorkflow(organizationId, task.parentWorkflowExecutionId);
      if (workflow) {
        await this.workflows
          .markCancelled({ organizationId, id: workflow.id, expectedRevision: workflow.revision, state: workflow.state as Record<string, unknown> })
          .catch(() => undefined);
      }
    }
    await this.evaluateJoin(task.correlationId);
    return this.toView(updated);
  }

  async retryTask(organizationId: string, taskId: string): Promise<DelegatedTaskView> {
    const task = await this.prisma.employeeDelegatedTask.findFirstOrThrow({ where: { id: taskId, organizationId } });
    if (task.status !== "FAILED" && task.status !== "TIMED_OUT") {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "Only failed or timed-out tasks can be retried.");
    }
    if (task.attemptCount >= task.maxAttempts) {
      throw new IdentityApplicationError("DELEGATION_NOT_ALLOWED", "This task has exhausted its retry budget.");
    }
    await this.prisma.employeeDelegatedTask.update({
      where: { id: taskId },
      data: { status: "QUEUED", errorCode: null, errorMessageSafe: null, timeoutAt: new Date(Date.now() + 15_000) }
    });
    return this.dispatch(taskId);
  }

  /** Transitions the linked WorkflowExecution (whether it's tracking approval-wait or plain async
   *  durability) back to COMPLETED/FAILED once its delegated task resolves. For a purely synchronous
   *  delegation there is no separate workflow to resume — the caller's own `await delegate(...)` already
   *  "resumes" by receiving the return value. */
  async resumeParent(taskId: string): Promise<void> {
    const task = await this.prisma.employeeDelegatedTask.findUniqueOrThrow({ where: { id: taskId } });
    await this.audit.record("WORKFORCE_PARENT_RESUMED", taskId, {
      organizationId: task.organizationId,
      taskId,
      parentWorkflowExecutionId: task.parentWorkflowExecutionId ?? undefined
    });
    if (!task.parentWorkflowExecutionId) return;
    const workflow = await this.workflows.loadWorkflow(task.organizationId, task.parentWorkflowExecutionId);
    if (!workflow || workflow.status === "COMPLETED" || workflow.status === "FAILED" || workflow.status === "CANCELLED") return;
    const succeeded = task.status === "COMPLETED";
    await (succeeded
      ? this.workflows.markCompleted({
          organizationId: task.organizationId,
          id: workflow.id,
          expectedRevision: workflow.revision,
          state: { ...(workflow.state as Record<string, unknown>), delegatedTaskStatus: task.status },
          currentStep: "DELEGATION_RESULT_RECEIVED"
        })
      : this.workflows.markFailed({
          organizationId: task.organizationId,
          id: workflow.id,
          expectedRevision: workflow.revision,
          state: { ...(workflow.state as Record<string, unknown>), delegatedTaskStatus: task.status },
          currentStep: "DELEGATION_FAILED"
        })
    ).catch((error) => {
      // A revision conflict here means another path already resumed this workflow — never re-throw and
      // never let it fail the task's own already-committed COMPLETED/FAILED transition.
      this.logger.warn({ event: "WorkforceResumeParentConflict", taskId, error: String(error) });
    });
  }

  // ---------------------------------------------------------------------
  // Least-privilege memory sharing (Phase 8/9)
  // ---------------------------------------------------------------------

  private async buildSharedMemoryContext(
    organizationId: string,
    sourceEmployeeInstallationId: string,
    requestedCategories: string[]
  ): Promise<{ lines: string[]; sharedFacts: Array<{ category: string; key: string; value: unknown }> }> {
    if (requestedCategories.length === 0) return { lines: [], sharedFacts: [] };
    const policy = await this.policyService.getOrCreate(organizationId);
    if (policy.crossEmployeeMemorySharingMode === "NONE") return { lines: [], sharedFacts: [] };

    const context = await this.memoryService.recall(organizationId, {
      userId: null,
      employeeId: sourceEmployeeInstallationId,
      conversationId: null
    });
    // Never USER-scope (Phase 8: "Do not automatically send... all user memory") and never CONVERSATION
    // history — only ORGANIZATION-wide facts and the source's own EMPLOYEE-scope facts are even eligible.
    const candidates = [...context.organization, ...context.employee];
    const requestedSet = new Set(requestedCategories.map((category) => category.toUpperCase()));
    const fullMode = policy.crossEmployeeMemorySharingMode === "FULL";

    const filtered = candidates.filter((record) => {
      if (!fullMode && !requestedSet.has(record.category.toUpperCase())) return false;
      if (NEVER_SHARED_IMPORTANCE.has(record.importance)) return false; // sensitivity filter, no opt-out
      return true;
    });

    const sharedFacts = filtered.map((record) => ({ category: record.category, key: record.key, value: record.value }));
    const lines =
      sharedFacts.length > 0
        ? [
            "Shared context (selected facts only, not the full conversation or memory store):",
            ...sharedFacts.map((fact) => `- [${fact.category}] ${fact.key}: ${JSON.stringify(fact.value)}`)
          ]
        : [];
    return { lines, sharedFacts };
  }

  /** Writes what was shared as a short-lived EMPLOYEE-scope memory record on the TARGET, so the fact this
   *  collaboration happened is itself auditable/recallable — but only for a bounded window (Phase 9:
   *  "temporary collaboration context must expire"). Permanent extraction, if any, is a separate, normal
   *  memory-write decision the target employee makes on its own, not something delegation does for it. */
  private async persistTemporaryCollaborationContext(
    organizationId: string,
    targetEmployeeInstallationId: string,
    taskId: string,
    sharedFacts: Array<{ category: string; key: string; value: unknown }>
  ): Promise<void> {
    await this.memoryService.remember({
      organizationId,
      scope: "EMPLOYEE",
      employeeId: targetEmployeeInstallationId,
      key: `delegation-context:${taskId}`,
      category: "DELEGATION_CONTEXT",
      value: { taskId, sharedFacts },
      source: "SYSTEM",
      importance: "LOW",
      expiresAt: new Date(Date.now() + SHARED_CONTEXT_TTL_MS)
    });
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async getTask(organizationId: string, taskId: string): Promise<DelegatedTaskView | null> {
    const task = await this.prisma.employeeDelegatedTask.findFirst({ where: { id: taskId, organizationId } });
    if (!task) return null;
    if (task.status === "WAITING_FOR_APPROVAL") return this.syncFromApproval(taskId);
    return this.toView(task);
  }

  async listTasks(
    organizationId: string,
    filters: { status?: string; sourceEmployeeInstallationId?: string; targetEmployeeInstallationId?: string; correlationId?: string } = {}
  ): Promise<DelegatedTaskView[]> {
    const tasks = await this.prisma.employeeDelegatedTask.findMany({
      where: {
        organizationId,
        ...(filters.status ? { status: filters.status as never } : {}),
        ...(filters.sourceEmployeeInstallationId ? { sourceEmployeeInstallationId: filters.sourceEmployeeInstallationId } : {}),
        ...(filters.targetEmployeeInstallationId ? { targetEmployeeInstallationId: filters.targetEmployeeInstallationId } : {}),
        ...(filters.correlationId ? { correlationId: filters.correlationId } : {})
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    return tasks.map((task) => this.toView(task));
  }

  private toView(task: {
    id: string;
    organizationId: string;
    sourceEmployeeInstallationId: string;
    targetEmployeeInstallationId: string;
    taskType: string;
    title: string;
    status: string;
    mode: string;
    priority: number;
    correlationId: string;
    delegationDepth: number;
    attemptCount: number;
    maxAttempts: number;
    resultPayloadJson: unknown;
    errorCode: string | null;
    errorMessageSafe: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    parentWorkflowExecutionId: string | null;
  }): DelegatedTaskView {
    return {
      id: task.id,
      organizationId: task.organizationId,
      sourceEmployeeInstallationId: task.sourceEmployeeInstallationId,
      targetEmployeeInstallationId: task.targetEmployeeInstallationId,
      taskType: task.taskType,
      title: task.title,
      status: task.status,
      mode: task.mode,
      priority: task.priority,
      correlationId: task.correlationId,
      delegationDepth: task.delegationDepth,
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      resultSummary: summarizeResult(task.resultPayloadJson),
      errorCode: task.errorCode,
      errorMessageSafe: task.errorMessageSafe,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      parentWorkflowExecutionId: task.parentWorkflowExecutionId
    };
  }
}

function readRequestedMemoryCategories(contract: DelegationContract): string[] {
  const raw = (contract as unknown as { requestedMemoryCategories?: unknown }).requestedMemoryCategories;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Deliberately does NOT name the source employee as "<Name> Employee"/"<Name> team" — the deterministic
 * domain providers (employee-runtime.ts's detectOutOfScopeEmployee) treat exactly that phrasing as an
 * explicit routing signal and redirect away instead of answering, which turned every delegation in live
 * UAT into a bounce-back to the source. The source's identity is already tracked on the task row itself
 * (sourceEmployeeInstallationId); the target doesn't need it restated in the prompt to do the work.
 */
function renderInstructions(plan: DelegationPlan, sharedContextLines: string[]): string {
  const lines = [
    "[Internal task handoff — answer directly, this is not a customer message]",
    `Objective: ${plan.contract.objective}`,
    `Task type: ${plan.contract.taskType}`,
    `Input: ${JSON.stringify(plan.contract.input)}`,
    ...sharedContextLines
  ];
  if (plan.contract.expectedOutput) {
    lines.push(
      `Respond ONLY with a single JSON object with exactly these fields: ${Object.keys(plan.contract.expectedOutput).join(", ")}. No prose, no markdown fences.`
    );
  }
  return lines.join("\n");
}

/** The target may be a real LLM instructed to return JSON, or (in this dev environment) the deterministic
 *  canned-response provider, which returns plain prose. Either is accepted — a non-JSON response is simply
 *  wrapped, never dropped. */
function parseResultPayload(responseText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to plain-text wrapping
  }
  return { response: responseText };
}

function summarizeResult(resultPayloadJson: unknown): string | null {
  if (!resultPayloadJson || typeof resultPayloadJson !== "object") return null;
  const text = JSON.stringify(resultPayloadJson);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function safeMessage(message: string): string {
  return message.slice(0, 500);
}

/** Generic, delegation-source-agnostic read of a known customer name out of a task's own persisted
 *  contract input — the same `HandoffContext.customerIdentity.displayName` shape the Receptionist already
 *  writes into `inputPayloadJson` for both single-target and parallel/multi-employee delegation, so a
 *  multi-employee handoff passes the same safe identity to every delegated specialist without a bespoke
 *  code path per caller. */
function delegatedCustomerName(inputPayloadJson: unknown): string | null {
  if (!inputPayloadJson || typeof inputPayloadJson !== "object") return null;
  const identity = (inputPayloadJson as Record<string, unknown>).customerIdentity;
  if (!identity || typeof identity !== "object") return null;
  const displayName = (identity as Record<string, unknown>).displayName;
  return typeof displayName === "string" && displayName.trim() ? displayName : null;
}
