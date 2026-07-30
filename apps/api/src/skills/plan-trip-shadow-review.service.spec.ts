import { NotFoundException } from "@nestjs/common";
import { SkillExecutionStatus, type Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  PlanTripShadowReviewService,
  recommendPlanTripRollout
} from "./plan-trip-shadow-review.service";

const fields = (origin = true) => ({
  origin,
  destination: true,
  departureDay: true,
  departureMonth: true,
  departureYear: true,
  travellers: true,
  durationOrReturnDate: true
});

function metadata(input: {
  executionId: string;
  status: string;
  revision: number;
  agreement?: boolean;
  capabilityAgreement?: boolean;
  reasonCodes?: string[];
  adapterWarnings?: string[];
  pendingInput?: string | null;
  originComplete?: boolean;
  diagnosticSignals?: string[];
}) {
  return {
    skillShadow: {
      skillId: "travel.plan-trip",
      skillVersion: "1.0.0",
      mode: "SHADOW",
      existingDecision: input.agreement === false ? "READY_FOR_PLAN" : "ASK_FOR_INPUT",
      shadowDecision: input.agreement === false ? "ASK_FOR_INPUT" : "ASK_FOR_INPUT",
      agreement: input.agreement ?? true,
      capabilityAgreement: input.capabilityAgreement ?? true,
      shadowCapabilities: {
        itinerary: true,
        estimate: true,
        liveSearch: input.status === "READY",
        booking: input.status === "READY"
      },
      reasonCodes: input.reasonCodes ?? [],
      adapterWarnings: input.adapterWarnings ?? [],
      shadowMissingField: input.pendingInput ?? null,
      fieldCompleteness: fields(input.originComplete ?? true),
      diagnosticSignals: input.diagnosticSignals ?? [],
      persistence: {
        executionId: input.executionId,
        status: input.status,
        revision: input.revision,
        applied: true,
        idempotentReplay: false,
        warning: input.reasonCodes?.includes("SKILL_REVISION_CONFLICT")
          ? "SKILL_REVISION_CONFLICT"
          : null
      }
    }
  };
}

function row(
  id: string,
  conversationId: string,
  modelProvider: string,
  value: Prisma.InputJsonObject
) {
  return {
    id,
    conversationId,
    modelProvider,
    metadata: value,
    createdAt: new Date(`2026-07-0${id.at(-1)}T00:00:00.000Z`)
  };
}

function harness() {
  let stored: Prisma.JsonValue | null = null;
  const rows = [
    row(
      "turn-1",
      "conversation-1",
      "travel-employee",
      metadata({
        executionId: "skill-1",
        status: "WAITING_FOR_INPUT",
        revision: 1,
        pendingInput: "DURATION"
      })
    ),
    row(
      "turn-2",
      "conversation-1",
      "travel-employee",
      metadata({ executionId: "skill-1", status: "READY", revision: 2 })
    ),
    row(
      "turn-3",
      "conversation-2",
      "openai-compatible",
      metadata({
        executionId: "skill-2",
        status: "READY",
        revision: 1,
        agreement: false,
        reasonCodes: ["EXISTING_ASKING_SHADOW_READY"]
      })
    ),
    row(
      "turn-4",
      "conversation-3",
      "openai-compatible",
      metadata({
        executionId: "skill-3",
        status: "WAITING_FOR_INPUT",
        revision: 1,
        agreement: false,
        capabilityAgreement: false,
        reasonCodes: ["ADAPTER_INCOMPLETE"],
        adapterWarnings: ["NO_CANONICAL_TRIP_FIELDS"],
        pendingInput: "ORIGIN"
      })
    )
  ];
  const prisma = {
    plugin: { findFirst: vi.fn().mockResolvedValue({ id: "plugin-1" }) },
    agentMemory: {
      create: vi.fn(async ({ data }: { data: { value: Prisma.JsonValue } }) => {
        stored = data.value;
        return { id: "memory-1" };
      }),
      findFirst: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        where.organizationId === "org-1" && stored ? { id: "memory-1", value: stored } : null
      ),
      updateMany: vi.fn(async ({ data }: { data: { value: Prisma.JsonValue } }) => {
        stored = data.value;
        return { count: 1 };
      })
    },
    agentExecution: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id?.in ? rows.filter((item) => where.id?.in.includes(item.id)) : rows
      )
    },
    skillExecution: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "skill-1",
          conversationId: "conversation-1",
          status: SkillExecutionStatus.READY,
          revision: 2,
          pendingInput: null
        },
        {
          id: "skill-2",
          conversationId: "conversation-2",
          status: SkillExecutionStatus.READY,
          revision: 1,
          pendingInput: null
        },
        {
          id: "skill-3",
          conversationId: "conversation-3",
          status: SkillExecutionStatus.WAITING_FOR_INPUT,
          revision: 1,
          pendingInput: "ORIGIN"
        }
      ])
    }
  };
  return {
    prisma,
    rows,
    service: new PlanTripShadowReviewService(prisma as unknown as PrismaService)
  };
}

const createInput = {
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-07-31T23:59:59.999Z",
  pluginInstallationId: "20000000-0000-0000-0000-000000000001",
  runtimeMode: "ALL" as const,
  conversationCount: 100,
  turnCount: 1000,
  notes: "Do not expose Delhi, a traveller name, or 999@example.com"
};

describe("PlanTripShadowReviewService", () => {
  it("creates, starts, completes, and archives a redacted review session", async () => {
    const { service } = harness();
    const created = await service.createSession("org-1", "reviewer-1", createInput);
    expect(created).toMatchObject({
      status: "CREATED",
      reviewer: "reviewer-1",
      notes: "[REDACTED_OPERATIONAL_NOTES]",
      sampledConversationCount: 0
    });
    const running = await service.startSession("org-1", created.sessionId);
    expect(running).toMatchObject({
      status: "RUNNING",
      sampledConversationCount: 3,
      sampledTurnCount: 4
    });
    expect((await service.completeSession("org-1", created.sessionId)).status).toBe("COMPLETED");
    expect((await service.archiveSession("org-1", created.sessionId)).status).toBe("ARCHIVED");
  });

  it("samples deterministically with bounded conversation and turn counts", async () => {
    const { service, prisma } = harness();
    const created = await service.createSession("org-1", "reviewer-1", {
      ...createInput,
      conversationCount: 2,
      turnCount: 3
    });
    const running = await service.startSession("org-1", created.sessionId);
    expect(running).toMatchObject({ sampledConversationCount: 2, sampledTurnCount: 3 });
    expect(prisma.agentExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          pluginInstallationId: createInput.pluginInstallationId,
          createdAt: {
            gte: new Date(createInput.from),
            lte: new Date(createInput.to)
          }
        }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }]
      })
    );
  });

  it.each([
    ["DETERMINISTIC", { modelProvider: "travel-employee" }],
    ["LLM", { modelProvider: { not: null, notIn: ["travel-employee"] } }]
  ] as const)("applies the %s runtime filter", async (runtimeMode, expected) => {
    const { service, prisma } = harness();
    const created = await service.createSession("org-1", "reviewer-1", {
      ...createInput,
      runtimeMode
    });
    await service.startSession("org-1", created.sessionId);
    expect(prisma.agentExecution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(expected) })
    );
  });

  it("never loads a review session from another tenant", async () => {
    const { service } = harness();
    const created = await service.createSession("org-1", "reviewer-1", createInput);
    await expect(service.getSession("org-2", created.sessionId)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it("aggregates trends, blocking/policy issues, capabilities, runtime split, and recommendation", async () => {
    const { service } = harness();
    const created = await service.createSession("org-1", "reviewer-1", createInput);
    await service.startSession("org-1", created.sessionId);
    const report = await service.report("org-1", created.sessionId);
    expect(report).toMatchObject({
      conversationCount: 3,
      turnCount: 4,
      agreementCount: 2,
      disagreementCount: 2,
      blockingCount: 1,
      policyCount: 1,
      adapterWarningCount: 1,
      revisionConflictCount: 0,
      stateLossCount: 0,
      unexpectedOverwriteCount: 0,
      recommendation: "NOT_READY",
      capabilityAgreement: { evaluated: 4, agreements: 3, mismatches: 1, agreementPercentage: 75 },
      trends: {
        overallAgreementPercentage: 50,
        blockingPercentage: 25,
        policyPercentage: 25,
        adapterPercentage: 25,
        runtimeModeSplit: { deterministicTurns: 2, llmTurns: 2, unknownTurns: 0 },
        averageTurnsPerConversation: 1.33,
        averagePendingInputsPerConversation: 0.67,
        averageRevisionsPerConversation: 1.33
      }
    });
    expect(report.blockingIssues).toEqual([
      expect.objectContaining({ code: "ADAPTER_INCOMPLETE", classification: "BLOCKING" })
    ]);
    expect(report.policyIssues).toEqual([
      expect.objectContaining({
        code: "EXISTING_ASKING_SHADOW_READY",
        classification: "PRODUCT_POLICY_REVIEW"
      })
    ]);
  });

  it("returns only redacted diagnostics in the deterministic report", async () => {
    const { service } = harness();
    const created = await service.createSession("org-1", "reviewer-1", createInput);
    await service.startSession("org-1", created.sessionId);
    const serialized = JSON.stringify(await service.report("org-1", created.sessionId));
    expect(serialized).not.toMatch(
      /Delhi|traveller name|999@example\.com|prompt|message|destination|budget|canonicalState|rawState/i
    );
  });

  it("treats redacted state-loss, overwrite, and revision-conflict signals as blocking", async () => {
    const { service, rows } = harness();
    const firstShadow = (rows[0]?.metadata as
      | Record<string, Record<string, unknown>>
      | undefined)?.skillShadow;
    if (!firstShadow) throw new Error("MISSING_TEST_SHADOW");
    firstShadow.diagnosticSignals = [
      "CROSS_TURN_STATE_LOSS",
      "CORRECTION_OVERWROTE_UNRELATED_FIELDS"
    ];
    const lastShadow = (rows[3]?.metadata as
      | Record<string, Record<string, unknown>>
      | undefined)?.skillShadow;
    if (!lastShadow) throw new Error("MISSING_TEST_SHADOW");
    lastShadow.reasonCodes = ["SKILL_REVISION_CONFLICT"];
    const created = await service.createSession("org-1", "reviewer-1", createInput);
    await service.startSession("org-1", created.sessionId);
    const report = await service.report("org-1", created.sessionId);
    expect(report).toMatchObject({
      recommendation: "NOT_READY",
      revisionConflictCount: 1,
      stateLossCount: 1,
      unexpectedOverwriteCount: 1
    });
    expect(report.blockingIssues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "CROSS_TURN_STATE_LOSS",
        "CORRECTION_OVERWROTE_UNRELATED_FIELDS",
        "SKILL_REVISION_CONFLICT"
      ])
    );
  });
});

describe("recommendPlanTripRollout", () => {
  it("returns NOT_READY for any blocking issue", () => {
    expect(
      recommendPlanTripRollout({
        conversationCount: 200,
        blockingCount: 1,
        stateLossCount: 0,
        unexpectedOverwriteCount: 0,
        agreementPercentage: 100
      })
    ).toBe("NOT_READY");
  });

  it("requires at least 100 conversations", () => {
    expect(
      recommendPlanTripRollout({
        conversationCount: 99,
        blockingCount: 0,
        stateLossCount: 0,
        unexpectedOverwriteCount: 0,
        agreementPercentage: 100
      })
    ).toBe("READY_FOR_MORE_UAT");
  });

  it("allows limited rollout at the accepted threshold but never recommends authority", () => {
    expect(
      recommendPlanTripRollout({
        conversationCount: 100,
        blockingCount: 0,
        stateLossCount: 0,
        unexpectedOverwriteCount: 0,
        agreementPercentage: 95
      })
    ).toBe("READY_FOR_LIMITED_ROLLOUT");
  });
});
