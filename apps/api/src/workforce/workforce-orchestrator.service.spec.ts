import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorkforceOrchestratorService } from "./workforce-orchestrator.service";
import { DelegationContractValidator } from "./delegation-contract";
import type { WorkforceEmployee } from "./employee-registry";

function baseEmployee(overrides: Partial<WorkforceEmployee> = {}): WorkforceEmployee {
  return {
    installationId: "emp-1",
    displayName: "Employee",
    pluginSlug: "employee",
    status: "ACTIVE",
    employeeType: "GENERIC",
    routingDomains: [],
    aliases: [],
    capabilities: ["CRM"],
    grantedPermissions: ["LLM", "MEMORY", "TOOLS", "CRM"],
    availableTools: [],
    supportedWorkflowTypes: [],
    knowledgeScope: { collections: 0, hasKnowledge: false },
    collaboration: {
      enabled: true,
      priority: 0,
      supportsSynchronous: true,
      supportsAsynchronous: false,
      maximumExecutionTimeMs: 30_000,
      supportedTaskTypes: ["GENERAL_QUERY"],
      requiredCapabilities: ["LLM"],
      sensitiveActions: [],
      defaultFailureBehaviour: "FAIL_PARENT"
    },
    ...overrides
  };
}

const DEFAULT_POLICY = {
  collaborationEnabled: true,
  maximumDelegationDepth: 2,
  maximumTasksPerParentExecution: 10,
  allowedSourceEmployeeIds: [],
  allowedTargetEmployeeIds: [],
  allowedTaskTypes: [],
  crossEmployeeMemorySharingMode: "SELECTED_FACTS_ONLY",
  requireApprovalForSensitiveDelegation: true,
  delegationTimeoutMs: 15000,
  retryLimit: 1,
  allowParallelDelegation: true,
  exposeDelegationToUser: true
};

function buildOrchestrator(options: {
  source?: WorkforceEmployee;
  target?: WorkforceEmployee;
  policy?: Partial<typeof DEFAULT_POLICY>;
  routing?: { shouldDelegate: boolean; targetEmployeeInstallationId: string | null; confidence: number; reasonCode: string; alternatives: unknown[] };
  parentTask?: Record<string, unknown> | null;
  existingTask?: Record<string, unknown> | null;
  // Phase 5.3 — defaults to ACTIVE so none of the pre-existing tests below are affected.
  organizationStatus?: string;
}) {
  const source = options.source ?? baseEmployee({ installationId: "source-1", displayName: "Source" });
  const target = options.target ?? baseEmployee({ installationId: "target-1", displayName: "Target" });
  const registry = {
    getInstalled: vi.fn((_org: string, id: string) =>
      Promise.resolve(id === source.installationId ? source : id === target.installationId ? target : null)
    ),
    listInstalled: vi.fn().mockResolvedValue([source, target])
  };
  const router = {
    route: vi
      .fn()
      .mockResolvedValue(
        options.routing ?? {
          shouldDelegate: true,
          targetEmployeeInstallationId: target.installationId,
          taskType: "GENERAL_QUERY",
          confidence: 0.95,
          reasonCode: "TASK_TYPE_MATCH",
          alternatives: []
        }
      )
  };
  const policyService = { getOrCreate: vi.fn().mockResolvedValue({ ...DEFAULT_POLICY, ...options.policy }) };
  const prisma = {
    employeeDelegatedTask: {
      findFirst: vi.fn().mockResolvedValue(options.parentTask ?? null),
      findUnique: vi.fn().mockResolvedValue(options.existingTask ?? null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(options.existingTask ?? {}),
      findFirstOrThrow: vi.fn().mockResolvedValue(options.existingTask ?? {}),
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "task-1", ...args.data })),
      update: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "task-1", ...(options.existingTask ?? {}), ...args.data })),
      findMany: vi.fn().mockResolvedValue([])
    },
    employeeDelegationJoin: {
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: "join-1", ...args.data })),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirstOrThrow: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    conversation: { create: vi.fn().mockResolvedValue({ id: "conv-1" }) },
    workflowExecution: { create: vi.fn().mockResolvedValue({ id: "wf-1" }), update: vi.fn() },
    organization: { findUnique: vi.fn().mockResolvedValue({ status: options.organizationStatus ?? "ACTIVE" }) }
  };
  const agentService = {
    execute: vi.fn().mockResolvedValue({ conversationId: "conv-1", executionId: "exec-1", response: JSON.stringify({ ok: true }) })
  };
  const approvalService = { create: vi.fn().mockResolvedValue({ id: "approval-1" }), findById: vi.fn() };
  const memoryService = {
    recall: vi.fn().mockResolvedValue({ organization: [], employee: [], user: [], conversationSummary: null, conversationSummaryVersion: null }),
    remember: vi.fn().mockResolvedValue({})
  };
  const workflows = {
    createWorkflow: vi.fn().mockResolvedValue({ execution: { id: "wf-1" }, applied: true, idempotentReplay: false }),
    loadWorkflow: vi.fn().mockResolvedValue(null),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    markCancelled: vi.fn()
  };
  const events = { onApprovalDecided: vi.fn(), emitApprovalDecided: vi.fn() };
  const audit = { record: vi.fn() };
  const FAKE_ROOT_CONTEXT = {
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: null,
    correlationId: null,
    causationId: null,
    organizationId: "org-1",
    sampled: false
  };
  const observability = {
    withSpan: vi.fn((context: unknown, _metadata: unknown, callback: (span: unknown) => unknown) =>
      callback(context ?? FAKE_ROOT_CONTEXT)
    ),
    startTrace: vi.fn().mockResolvedValue(FAKE_ROOT_CONTEXT),
    completeTrace: vi.fn(),
    failTrace: vi.fn(),
    startSpan: vi.fn().mockResolvedValue(FAKE_ROOT_CONTEXT),
    completeSpan: vi.fn(),
    failSpan: vi.fn(),
    addAttribute: vi.fn(),
    addEvent: vi.fn(),
    recordMetric: vi.fn(),
    recordError: vi.fn()
  };

  const orchestrator = new WorkforceOrchestratorService(
    prisma as never,
    registry as never,
    router as never,
    new DelegationContractValidator(),
    policyService as never,
    agentService as never,
    approvalService as never,
    memoryService as never,
    workflows as never,
    events as never,
    audit as never,
    observability as never
  );
  return { orchestrator, source, target, prisma, registry, router, policyService, agentService, memoryService, workflows, events, observability };
}

const CONTRACT = { taskType: "GENERAL_QUERY", objective: "Help with something", input: {} };

describe("WorkforceOrchestratorService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("plans a valid top-level delegation successfully", async () => {
    const { orchestrator, target } = buildOrchestrator({});
    const plan = await orchestrator.planDelegation({
      organizationId: "org-1",
      sourceEmployeeInstallationId: "source-1",
      contract: CONTRACT
    });
    expect(plan.target.installationId).toBe(target.installationId);
    expect(plan.parentDepth).toBe(1);
  });

  it("rejects delegation when the org has collaboration disabled", async () => {
    const { orchestrator } = buildOrchestrator({ policy: { collaborationEnabled: false } });
    await expect(
      orchestrator.planDelegation({ organizationId: "org-1", sourceEmployeeInstallationId: "source-1", contract: CONTRACT })
    ).rejects.toMatchObject({ code: "DELEGATION_NOT_ALLOWED" });
  });

  it("rejects when the router finds no eligible employee", async () => {
    const { orchestrator } = buildOrchestrator({
      routing: { shouldDelegate: false, targetEmployeeInstallationId: null, confidence: 0, reasonCode: "NO_ELIGIBLE_EMPLOYEE", alternatives: [] }
    });
    await expect(
      orchestrator.planDelegation({ organizationId: "org-1", sourceEmployeeInstallationId: "source-1", contract: CONTRACT })
    ).rejects.toMatchObject({ code: "NO_ELIGIBLE_EMPLOYEE" });
  });

  it("rejects a target missing a required base capability (confused-deputy guard)", async () => {
    const target = baseEmployee({ installationId: "target-1", grantedPermissions: ["MEMORY"] }); // no LLM
    const { orchestrator } = buildOrchestrator({ target });
    await expect(
      orchestrator.planDelegation({ organizationId: "org-1", sourceEmployeeInstallationId: "source-1", contract: CONTRACT })
    ).rejects.toMatchObject({ code: "WORKFORCE_CAPABILITY_NOT_GRANTED" });
  });

  it("rejects when the requested targetCapability is not held by the target — the source cannot lend its own privileges", async () => {
    const target = baseEmployee({ installationId: "target-1", capabilities: ["CRM"], grantedPermissions: ["LLM", "CRM"] });
    const { orchestrator } = buildOrchestrator({ target });
    await expect(
      orchestrator.planDelegation({
        organizationId: "org-1",
        sourceEmployeeInstallationId: "source-1",
        contract: { ...CONTRACT, targetCapability: "travel.booking" }
      })
    ).rejects.toMatchObject({ code: "WORKFORCE_CAPABILITY_NOT_GRANTED" });
  });

  it("detects a delegation cycle (A -> B -> A)", async () => {
    const { orchestrator } = buildOrchestrator({
      parentTask: { id: "parent-1", delegationChain: ["target-1"], delegationDepth: 1, correlationId: "corr-1" }
    });
    // source-1 delegating back to target-1, which is already in the chain -> cycle.
    await expect(
      orchestrator.planDelegation({
        organizationId: "org-1",
        sourceEmployeeInstallationId: "source-1",
        contract: CONTRACT,
        parentTaskId: "parent-1"
      })
    ).rejects.toMatchObject({ code: "DELEGATION_CYCLE_DETECTED" });
  });

  it("enforces the maximum delegation depth", async () => {
    const { orchestrator } = buildOrchestrator({
      policy: { maximumDelegationDepth: 2 },
      parentTask: { id: "parent-1", delegationChain: ["other-1", "other-2"], delegationDepth: 2, correlationId: "corr-1" }
    });
    await expect(
      orchestrator.planDelegation({
        organizationId: "org-1",
        sourceEmployeeInstallationId: "source-1",
        contract: CONTRACT,
        parentTaskId: "parent-1"
      })
    ).rejects.toMatchObject({ code: "DELEGATION_DEPTH_EXCEEDED" });
  });

  it("rejects when the source employee is not installed in this organization (cross-tenant safe)", async () => {
    const { orchestrator, registry } = buildOrchestrator({});
    registry.getInstalled.mockResolvedValue(null);
    await expect(
      orchestrator.planDelegation({ organizationId: "org-1", sourceEmployeeInstallationId: "foreign-employee", contract: CONTRACT })
    ).rejects.toMatchObject({ code: "WORKFORCE_EMPLOYEE_NOT_INSTALLED" });
  });

  it("ignores a duplicate completion instead of erroring or re-resuming the parent", async () => {
    const { orchestrator, prisma } = buildOrchestrator({
      existingTask: { id: "task-1", status: "COMPLETED", organizationId: "org-1", createdAt: new Date() }
    });
    const view = await orchestrator.completeTask("task-1", { ok: true });
    expect(view.status).toBe("COMPLETED");
    expect(prisma.employeeDelegatedTask.update).not.toHaveBeenCalled();
  });

  it("rejects completing a task that already failed", async () => {
    const { orchestrator } = buildOrchestrator({ existingTask: { id: "task-1", status: "FAILED", organizationId: "org-1" } });
    await expect(orchestrator.completeTask("task-1", { ok: true })).rejects.toMatchObject({
      code: "WORKFORCE_DUPLICATE_COMPLETION"
    });
  });

  // --- Phase 5.3 — background worker suspension audit ---------------------------------------------------

  it("dispatch() terminally fails a QUEUED task for a suspended organization without ever resolving an employee or running the agent", async () => {
    const { orchestrator, prisma, registry, agentService } = buildOrchestrator({
      organizationStatus: "SUSPENDED",
      existingTask: {
        id: "task-1",
        organizationId: "org-1",
        status: "QUEUED",
        timeoutAt: null,
        attemptCount: 0,
        maxAttempts: 3,
        correlationId: "corr-1",
        createdAt: new Date()
      }
    });
    const view = await orchestrator.dispatch("task-1");
    expect(view.status).toBe("FAILED");
    expect(view.errorCode).toBe("ORGANIZATION_SUSPENDED");
    // WorkforceTaskProcessor's background timer calls dispatch() on a call stack with no HTTP request and
    // no JwtAccessGuard — this assertion is the one that actually proves the gap is closed: no employee
    // was ever resolved and the AI agent was never invoked against a suspended tenant's data.
    expect(registry.getInstalled).not.toHaveBeenCalled();
    expect(agentService.execute).not.toHaveBeenCalled();
    // Never transitioned to RUNNING at any point — the suspension check runs strictly before that update.
    expect(prisma.employeeDelegatedTask.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING" }) })
    );
  });

  it("dispatch() does not false-positive the suspension check for an ACTIVE organization", async () => {
    const { orchestrator, prisma } = buildOrchestrator({
      organizationStatus: "ACTIVE",
      existingTask: {
        id: "task-1",
        organizationId: "org-1",
        status: "QUEUED",
        timeoutAt: null,
        attemptCount: 0,
        maxAttempts: 3,
        correlationId: "corr-1",
        sourceEmployeeInstallationId: "source-1",
        targetEmployeeInstallationId: "target-1",
        taskType: "GENERAL_QUERY",
        inputPayloadJson: { objective: "test", input: {} },
        createdAt: new Date()
      }
    });
    const view = await orchestrator.dispatch("task-1");
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({ where: { id: "org-1" }, select: { status: true } });
    expect(view.errorCode).not.toBe("ORGANIZATION_SUSPENDED");
    // Reached the RUNNING transition — proves the check passed through rather than short-circuiting.
    expect(prisma.employeeDelegatedTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "RUNNING" }) })
    );
  });
});
