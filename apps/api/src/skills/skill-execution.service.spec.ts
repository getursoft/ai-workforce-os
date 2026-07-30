import { Prisma, SkillExecutionStatus, type SkillExecution } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  SkillExecutionRevisionConflictError,
  SkillExecutionService,
  type SkillExecutionScope
} from "./skill-execution.service";
import {
  InvalidPlanTripSkillStateError,
  PlanTripSkillExecutionMapper
} from "./travel/plan-trip-skill-execution.mapper";
import {
  emptyPlanTripSkillState,
  mergePlanTripState,
  type PlanTripSkillState
} from "./travel/plan-trip.skill";

const scope: SkillExecutionScope = {
  organizationId: "10000000-0000-0000-0000-000000000001",
  pluginInstallationId: "20000000-0000-0000-0000-000000000001",
  conversationId: "30000000-0000-0000-0000-000000000001",
  skillId: "travel.plan-trip"
};
const executionId = "40000000-0000-0000-0000-000000000001";

function planState(): PlanTripSkillState {
  return mergePlanTripState(emptyPlanTripSkillState(), {
    data: {
      origin: { value: "Delhi", source: "USER_EXPLICIT" },
      destination: { value: "Dubai", source: "USER_EXPLICIT" },
      departureDate: {
        value: { value: "12 January", day: 12, month: 1, year: null },
        source: "USER_EXPLICIT"
      },
      duration: { value: { value: 4, unit: "NIGHTS" }, source: "USER_EXPLICIT" },
      travellers: { value: { total: 5 }, source: "USER_EXPLICIT" }
    }
  });
}

function harness() {
  const rows: SkillExecution[] = [];
  const prisma = {
    conversation: { count: async () => 1 },
    agentExecution: { count: async () => 1 },
    skillExecution: {
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
          id: `50000000-0000-0000-0000-${String(rows.length + 1).padStart(12, "0")}`,
          completedAt: null,
          completionReason: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          ...data
        } as SkillExecution;
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
  return { rows, service: new SkillExecutionService(prisma), prisma };
}

async function create(service: SkillExecutionService, turnId = "turn-1") {
  const state = planState();
  return service.createExecution({
    scope,
    skillVersion: "1.0.0",
    schemaVersion: 1,
    state,
    pendingInput: "TRAVEL_YEAR",
    agentExecutionId: executionId,
    turnId
  });
}

describe("SkillExecutionService mirror persistence", () => {
  it("creates and loads one tenant-scoped active execution while preserving the skill version", async () => {
    const { service } = harness();
    const created = await create(service);
    expect(created.execution).toMatchObject({
      ...scope,
      skillVersion: "1.0.0",
      status: SkillExecutionStatus.WAITING_FOR_INPUT
    });
    await expect(service.findActiveExecution(scope)).resolves.toMatchObject({
      id: created.execution.id
    });
    await expect(service.loadExecution("wrong-tenant", created.execution.id)).resolves.toBeNull();
  });

  it("increments revision on update and rejects a stale expected revision", async () => {
    const { service } = harness();
    const created = await create(service);
    const originalRevision = created.execution.revision;
    const state = { ...planState(), revision: originalRevision + 1 };
    const updated = await service.updateExecutionState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: originalRevision,
      state,
      pendingInput: "TRAVEL_YEAR",
      latestAgentExecutionId: executionId,
      turnId: "turn-2"
    });
    expect(updated.execution.revision).toBe(originalRevision + 1);
    await expect(
      service.updateExecutionState({
        organizationId: scope.organizationId,
        id: created.execution.id,
        expectedRevision: originalRevision,
        state,
        pendingInput: "TRAVEL_YEAR",
        latestAgentExecutionId: executionId,
        turnId: "turn-3"
      })
    ).rejects.toBeInstanceOf(SkillExecutionRevisionConflictError);
  });

  it("returns the unique active winner instead of creating a second execution", async () => {
    const { service, rows } = harness();
    const first = await create(service);
    const second = await create(service);
    expect(second.execution.id).toBe(first.execution.id);
    expect(second.idempotentReplay).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("does not return a completed execution as active and stores completion metadata", async () => {
    const { service } = harness();
    const created = await create(service);
    const completed = await service.markCompleted({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      latestAgentExecutionId: executionId,
      completionReason: "SHADOW_COMPLETE"
    });
    expect(completed).toMatchObject({
      status: SkillExecutionStatus.COMPLETED,
      completionReason: "SHADOW_COMPLETE",
      activeKey: null
    });
    expect(completed.completedAt).toBeInstanceOf(Date);
    await expect(service.findActiveExecution(scope)).resolves.toBeNull();
  });

  it("stores failure timestamp and reason", async () => {
    const { service } = harness();
    const created = await create(service);
    const failed = await service.markFailed({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      latestAgentExecutionId: executionId,
      completionReason: "MIRROR_VALIDATION_FAILED"
    });
    expect(failed.status).toBe(SkillExecutionStatus.FAILED);
    expect(failed.completedAt).toBeInstanceOf(Date);
    expect(failed.completionReason).toBe("MIRROR_VALIDATION_FAILED");
  });

  it("isolates a cancelled lifecycle from active lookup", async () => {
    const { service } = harness();
    const created = await create(service);
    const cancelled = await service.markCancelled({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      latestAgentExecutionId: executionId,
      completionReason: "CONVERSATION_CANCELLED"
    });
    expect(cancelled.status).toBe(SkillExecutionStatus.CANCELLED);
    expect(cancelled.activeKey).toBeNull();
    await expect(service.findActiveExecution(scope)).resolves.toBeNull();
  });

  it("is idempotent for the same turn but accepts identical text represented by a different turn ID", async () => {
    const { service } = harness();
    const created = await create(service);
    const state = planState();
    const replay = await service.updateExecutionState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state,
      pendingInput: "TRAVEL_YEAR",
      latestAgentExecutionId: executionId,
      turnId: "turn-1"
    });
    expect(replay).toMatchObject({ applied: false, idempotentReplay: true });
    expect(replay.execution.revision).toBe(created.execution.revision);
    const separateTurn = await service.updateExecutionState({
      organizationId: scope.organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state: { ...state, revision: state.revision + 1 },
      pendingInput: "TRAVEL_YEAR",
      latestAgentExecutionId: executionId,
      turnId: "turn-2"
    });
    expect(separateTurn.applied).toBe(true);
  });

  it("round-trips nights and an ambiguous traveller total without inventing adults", async () => {
    const { service } = harness();
    const created = await create(service);
    const restored = PlanTripSkillExecutionMapper.fromJson(created.execution.state);
    expect(restored.duration).toEqual({ value: 4, unit: "NIGHTS" });
    expect(restored.travellers).toEqual({ total: 5, adults: null, children: null, infants: null });
  });

  it("rejects invalid JSON state", () => {
    expect(() =>
      PlanTripSkillExecutionMapper.fromJson({ schemaVersion: 1 } as Prisma.JsonObject)
    ).toThrow(InvalidPlanTripSkillStateError);
  });

  it("a recreated service instance continues the same persisted execution", async () => {
    const { service, prisma } = harness();
    const created = await create(service);
    const recreated = new SkillExecutionService(prisma);
    await expect(recreated.findActiveExecution(scope)).resolves.toMatchObject({
      id: created.execution.id
    });
  });
});

function matches(row: SkillExecution, where: Record<string, unknown>): boolean {
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
