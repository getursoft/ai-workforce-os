import { Prisma, WorkflowStatus, type WorkflowExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  WorkflowExecutionRevisionConflictError,
  WorkflowExecutionService
} from "./workflow-execution.service";
import type { WorkflowExecutionScope } from "./workflow-runtime.contracts";

const scope: WorkflowExecutionScope = {
  organizationId: "10000000-0000-0000-0000-000000000001",
  pluginInstallationId: "20000000-0000-0000-0000-000000000001",
  conversationId: "30000000-0000-0000-0000-000000000001",
  workflowType: "CONTACT_CAPTURE"
};

function harness() {
  const rows: WorkflowExecution[] = [];
  const prisma = {
    workflowExecution: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (rows.some((row) => row.activeKey === data.activeKey))
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "6.19.3"
          });
        const now = new Date();
        const row = {
          id: `40000000-0000-0000-0000-${String(rows.length + 1).padStart(12, "0")}`,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data
        } as WorkflowExecution;
        rows.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "revision" && typeof value === "object" && value)
            row.revision += (value as { increment: number }).increment;
          else (row as unknown as Record<string, unknown>)[key] = value;
        }
        row.updatedAt = new Date();
        return { count: 1 };
      }
    }
  } as unknown as PrismaService;
  return { rows, service: new WorkflowExecutionService(prisma), prisma };
}

async function create(service: WorkflowExecutionService, turnId = "turn-1") {
  return service.createWorkflow({
    scope,
    currentStep: "COLLECT_MOBILE_NUMBER",
    pendingInput: "MOBILE_NUMBER",
    state: { mobileNumber: null },
    turnId
  });
}

describe("WorkflowExecutionService", () => {
  it("creates and loads one tenant-scoped active workflow, defaulting to WAITING_FOR_INPUT when a pendingInput is set", async () => {
    const { service } = harness();
    const created = await create(service);
    expect(created.execution).toMatchObject({
      ...scope,
      status: WorkflowStatus.WAITING_FOR_INPUT,
      pendingInput: "MOBILE_NUMBER"
    });
    await expect(service.findActiveWorkflow(scope)).resolves.toMatchObject({
      id: created.execution.id
    });
    await expect(service.loadWorkflow("wrong-tenant", created.execution.id)).resolves.toBeNull();
  });

  it("increments revision on update and rejects a stale expected revision", async () => {
    const { service } = harness();
    const created = await create(service);
    const originalRevision = created.execution.revision;
    const updated = await service.updateWorkflowState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: originalRevision,
      currentStep: "COLLECT_MOBILE_NUMBER",
      pendingInput: "MOBILE_NUMBER",
      state: { mobileNumber: null },
      turnId: "turn-2"
    });
    expect(updated.execution.revision).toBe(originalRevision + 1);
    await expect(
      service.updateWorkflowState({
        organizationId: scope.organizationId,
        id: created.execution.id,
        expectedRevision: originalRevision,
        currentStep: "COLLECT_MOBILE_NUMBER",
        pendingInput: "MOBILE_NUMBER",
        state: { mobileNumber: null },
        turnId: "turn-3"
      })
    ).rejects.toBeInstanceOf(WorkflowExecutionRevisionConflictError);
  });

  it("returns the unique active winner instead of creating a second workflow (one active per conversation+type)", async () => {
    const { service, rows } = harness();
    const first = await create(service);
    const second = await create(service, "turn-2");
    expect(second.execution.id).toBe(first.execution.id);
    expect(second.applied).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("does not return a completed workflow as active, and stores completion state", async () => {
    const { service } = harness();
    const created = await create(service);
    const completed = await service.markCompleted({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state: { mobileNumber: "8380031193", leadId: "lead-1" }
    });
    expect(completed).toMatchObject({ status: WorkflowStatus.COMPLETED, activeKey: null });
    expect(completed.completedAt).toBeInstanceOf(Date);
    await expect(service.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("stores failure state", async () => {
    const { service } = harness();
    const created = await create(service);
    const failed = await service.markFailed({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state: { mobileNumber: null }
    });
    expect(failed.status).toBe(WorkflowStatus.FAILED);
    expect(failed.completedAt).toBeInstanceOf(Date);
  });

  it("isolates a cancelled lifecycle from active lookup", async () => {
    const { service } = harness();
    const created = await create(service);
    const cancelled = await service.markCancelled({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state: { mobileNumber: null }
    });
    expect(cancelled.status).toBe(WorkflowStatus.CANCELLED);
    expect(cancelled.activeKey).toBeNull();
    await expect(service.findActiveWorkflow(scope)).resolves.toBeNull();
  });

  it("is idempotent for the same turn id — a duplicate transition never re-applies", async () => {
    const { service } = harness();
    const created = await create(service);
    const replay = await service.updateWorkflowState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      currentStep: "COLLECT_MOBILE_NUMBER",
      pendingInput: "MOBILE_NUMBER",
      state: { mobileNumber: null },
      turnId: "turn-1"
    });
    expect(replay).toMatchObject({ applied: false, idempotentReplay: true });
    expect(replay.execution.revision).toBe(created.execution.revision);
    const separateTurn = await service.updateWorkflowState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      currentStep: "COLLECT_MOBILE_NUMBER",
      pendingInput: "MOBILE_NUMBER",
      state: { mobileNumber: null },
      turnId: "turn-2"
    });
    expect(separateTurn.applied).toBe(true);
  });

  it("transitions status to ACTIVE once pendingInput becomes null", async () => {
    const { service } = harness();
    const created = await create(service);
    const updated = await service.updateWorkflowState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      currentStep: "COMPLETED",
      pendingInput: null,
      state: { mobileNumber: "8380031193" },
      turnId: "turn-2"
    });
    expect(updated.execution.status).toBe(WorkflowStatus.ACTIVE);
    expect(updated.execution.pendingInput).toBeNull();
  });

  it("restart durability: a recreated service instance resumes the same persisted workflow", async () => {
    const { service, prisma } = harness();
    const created = await create(service);
    const recreated = new WorkflowExecutionService(prisma);
    await expect(recreated.findActiveWorkflow(scope)).resolves.toMatchObject({
      id: created.execution.id
    });
  });
});

function matches(row: WorkflowExecution, where: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (typeof expected === "object" && expected !== null) {
      const condition = expected as { in?: unknown[]; not?: unknown };
      if (condition.in && !condition.in.includes(actual)) return false;
      if ("not" in condition && actual === condition.not) return false;
    } else if (actual !== expected) return false;
  }
  return true;
}
