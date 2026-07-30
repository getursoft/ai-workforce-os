import { NotFoundException } from "@nestjs/common";
import { SkillExecutionStatus } from "@prisma/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PlanTripSkillDiagnosticsService } from "./plan-trip-skill-diagnostics.service";
import { emptyPlanTripSkillState } from "./travel/plan-trip.skill";

const fields = {
  origin: true,
  destination: true,
  departureDay: true,
  departureMonth: true,
  departureYear: false,
  travellers: true,
  durationOrReturnDate: true
};

function metadata(input: {
  executionId?: string;
  agreement?: boolean;
  reasonCodes?: string[];
  existingDecision?: string;
  shadowDecision?: string;
  adapterWarnings?: string[];
  persistenceWarning?: string | null;
}) {
  return {
    skillShadow: {
      skillId: "travel.plan-trip",
      skillVersion: "1.0.0",
      mode: "SHADOW",
      existingDecision: input.existingDecision ?? "READY_FOR_PLAN",
      shadowDecision: input.shadowDecision ?? "ASK_FOR_INPUT",
      agreement: input.agreement ?? false,
      reasonCodes: input.reasonCodes ?? ["EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR"],
      adapterWarnings: input.adapterWarnings ?? [],
      fieldCompleteness: fields,
      persistence: {
        executionId: input.executionId ?? "skill-1",
        status: "WAITING_FOR_INPUT",
        revision: 2,
        applied: true,
        idempotentReplay: false,
        warning: input.persistenceWarning ?? null
      }
    }
  };
}

function harness() {
  const safeState = {
    ...emptyPlanTripSkillState(),
    purpose: "LEISURE" as const,
    budget: { amount: 100, currency: "USD" }
  };
  const prisma = {
    agentExecution: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          modelProvider: "travel-employee",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          metadata: metadata({})
        },
        {
          id: "agent-2",
          modelProvider: "openai-compatible",
          createdAt: new Date("2026-07-02T00:00:00.000Z"),
          metadata: metadata({
            reasonCodes: ["SKILL_PERSISTENCE_FAILED", "ADAPTER_INCOMPLETE"],
            adapterWarnings: ["NO_CANONICAL_TRIP_FIELDS"],
            persistenceWarning: "SKILL_PERSISTENCE_FAILED"
          })
        },
        {
          id: "agent-3",
          modelProvider: null,
          createdAt: new Date("2026-07-03T00:00:00.000Z"),
          metadata: metadata({
            agreement: true,
            reasonCodes: [],
            existingDecision: "NOT_APPLICABLE",
            shadowDecision: "NOT_APPLICABLE"
          })
        }
      ])
    },
    skillExecution: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "skill-1",
          status: SkillExecutionStatus.WAITING_FOR_INPUT,
          pendingInput: "TRAVEL_YEAR",
          processedTurnIds: ["one", "two", "three", "four", "five"],
          state: safeState
        },
        {
          id: "skill-2",
          status: SkillExecutionStatus.READY,
          pendingInput: null,
          processedTurnIds: ["six"],
          state: safeState
        }
      ]),
      findFirst: vi.fn().mockResolvedValue({
        id: "skill-1",
        organizationId: "org-1",
        conversationId: "conversation-1",
        skillId: "travel.plan-trip",
        skillVersion: "1.0.0",
        schemaVersion: 1,
        status: SkillExecutionStatus.WAITING_FOR_INPUT,
        revision: 2,
        startedAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-02T00:00:00.000Z"),
        completedAt: null,
        processedTurnIds: ["one", "two"],
        pendingInput: "TRAVEL_YEAR"
      })
    }
  };
  return {
    prisma,
    service: new PlanTripSkillDiagnosticsService(prisma as unknown as PrismaService)
  };
}

describe("PlanTripSkillDiagnosticsService", () => {
  it("builds a bounded tenant-scoped redacted summary", async () => {
    const { service, prisma } = harness();
    const result = await service.summary("org-1", {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T23:59:59.999Z",
      limit: 100,
      pluginInstallationId: "20000000-0000-0000-0000-000000000001"
    });
    expect(result).toMatchObject({
      totalApplicableEvaluations: 2,
      totalDistinctSkillExecutions: 2,
      agreements: 0,
      disagreements: 2,
      agreementPercentage: 0,
      capabilityAgreements: 0,
      capabilityDisagreements: 2,
      capabilityAgreementPercentage: 0,
      persistenceFailureCount: 1,
      revisionConflictCount: 0,
      executionsWithRepeatedDisagreement: 1,
      executionsWaitingUnusuallyManyTurns: 1,
      executionsReachingReady: 1,
      runtimeModeCounts: { deterministic: 1, llm: 1, unknown: 0 },
      classificationCounts: {
        BLOCKING: 2,
        PRODUCT_POLICY_REVIEW: 0,
        EXPECTED_NON_EQUIVALENCE: 2
      }
    });
    expect(prisma.agentExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          pluginInstallationId: "20000000-0000-0000-0000-000000000001"
        }),
        take: 100
      })
    );
    expect(JSON.stringify(result)).not.toMatch(/Delhi|Dubai|phone|email|budget|raw|message/i);
  });

  it("returns only redacted execution and timeline fields", async () => {
    const { service, prisma } = harness();
    const result = await service.execution("org-1", "skill-1");
    expect(result).toMatchObject({
      skillExecutionId: "skill-1",
      processedTurnCount: 2,
      pendingInput: "TRAVEL_YEAR",
      timeline: expect.arrayContaining([
        expect.objectContaining({
          agentExecutionId: "agent-1",
          runtimeMode: "DETERMINISTIC",
          fieldCompleteness: fields
        }),
        expect.objectContaining({ agentExecutionId: "agent-2", runtimeMode: "LLM" })
      ])
    });
    expect(prisma.skillExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "skill-1", organizationId: "org-1", skillId: "travel.plan-trip" }
      })
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/Delhi|Dubai|phone|email|budget|state|message|prompt/i);
  });

  it("returns not found when the tenant-scoped execution lookup misses", async () => {
    const { service, prisma } = harness();
    prisma.skillExecution.findFirst.mockResolvedValueOnce(null);
    await expect(service.execution("wrong-org", "skill-1")).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("publishes a deterministic synthetic fixture report clearly marked as non-production", () => {
    const path = resolve(
      process.cwd(),
      "../../docs/fixtures/travel-plan-trip-synthetic-validation.json"
    );
    const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({
      dataSource: "SYNTHETIC_TEST_FIXTURES_ONLY",
      totalEvaluations: 10,
      agreementRate: 60,
      blockingDisagreementCount: 2,
      productPolicyReviewCount: 2,
      expectedNonEquivalenceCount: 0,
      readinessRate: 40,
      persistenceFailures: 0,
      revisionConflicts: 0,
      productionMetric: false
    });
  });
});
