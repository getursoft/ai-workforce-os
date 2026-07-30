import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { AgentExecutionStatus, ConversationStatus, PluginStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PlanTripSkillDiagnosticsService } from "./plan-trip-skill-diagnostics.service";
import {
  SkillExecutionRevisionConflictError,
  SkillExecutionService
} from "./skill-execution.service";
import { PlanTripSkillExecutionMapper } from "./travel/plan-trip-skill-execution.mapper";
import {
  decidePlanTripTurn,
  emptyPlanTripSkillState,
  mergePlanTripState
} from "./travel/plan-trip.skill";

for (const path of [resolve(process.cwd(), ".env.test"), resolve(process.cwd(), "../../.env.test")])
  if (existsSync(path)) {
    loadEnvFile(path);
    break;
  }
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function requireDefined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("EXPECTED_SKILL_EXECUTION");
  return value;
}

suite("SkillExecutionService database persistence", () => {
  const prisma = new PrismaService();
  let organizationId: string;
  let pluginInstallationId: string;
  let conversationId: string;
  let agentExecutionId: string;

  beforeAll(async () => {
    await prisma.$connect();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const organization = await prisma.organization.create({
      data: { name: "Skill mirror test", slug: `skill-mirror-${suffix}` }
    });
    organizationId = organization.id;
    const plugin = await prisma.plugin.create({
      data: {
        organizationId,
        name: "Travel Employee",
        slug: `travel-skill-mirror-${suffix}`,
        version: "1.0.0",
        displayName: "Travel Employee",
        description: "Skill mirror database fixture",
        author: "test",
        status: PluginStatus.ACTIVE,
        entryPoint: "test",
        manifest: {}
      }
    });
    pluginInstallationId = plugin.id;
    const conversation = await prisma.conversation.create({
      data: { organizationId, pluginInstallationId, title: "Skill mirror conversation" }
    });
    conversationId = conversation.id;
    const execution = await prisma.agentExecution.create({
      data: {
        organizationId,
        pluginInstallationId,
        conversationId,
        status: AgentExecutionStatus.COMPLETED,
        requestId: "skill-db-turn-1"
      }
    });
    agentExecutionId = execution.id;
  });

  afterAll(async () => {
    if (organizationId)
      await prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("persists, reloads after service recreation, isolates tenants, and rejects stale revisions", async () => {
    const firstService = new SkillExecutionService(prisma);
    const state = mergePlanTripState(emptyPlanTripSkillState(), {
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
    const created = await firstService.createExecution({
      scope: {
        organizationId,
        pluginInstallationId,
        conversationId,
        skillId: "travel.plan-trip"
      },
      skillVersion: "1.0.0",
      schemaVersion: 1,
      state,
      pendingInput: "TRAVEL_YEAR",
      agentExecutionId,
      turnId: "skill-db-turn-1"
    });

    const recreatedService = new SkillExecutionService(prisma);
    const reloaded = await recreatedService.findActiveExecution({
      organizationId,
      pluginInstallationId,
      conversationId,
      skillId: "travel.plan-trip"
    });
    const persisted = requireDefined(reloaded);
    expect(persisted.id).toBe(created.execution.id);
    expect(persisted.skillVersion).toBe("1.0.0");
    expect(PlanTripSkillExecutionMapper.fromJson(persisted.state)).toMatchObject({
      origin: "Delhi",
      destination: "Dubai",
      duration: { value: 4, unit: "NIGHTS" },
      travellers: { total: 5, adults: null, children: null, infants: null }
    });
    await expect(
      recreatedService.loadExecution("00000000-0000-0000-0000-000000000000", persisted.id)
    ).resolves.toBeNull();

    const originalRevision = persisted.revision;
    const withYear = mergePlanTripState(PlanTripSkillExecutionMapper.fromJson(persisted.state), {
      data: {
        departureDate: {
          value: { value: "12 January 2027", day: 12, month: 1, year: 2027 },
          source: "USER_EXPLICIT"
        }
      }
    });
    const updated = await recreatedService.updateExecutionState({
      organizationId,
      id: persisted.id,
      expectedRevision: originalRevision,
      state: withYear,
      pendingInput: null,
      latestAgentExecutionId: agentExecutionId,
      turnId: "skill-db-turn-2"
    });
    expect(updated.execution.revision).toBe(originalRevision + 1);
    expect(PlanTripSkillExecutionMapper.fromJson(updated.execution.state).departureDate?.year).toBe(
      2027
    );
    await expect(
      recreatedService.updateExecutionState({
        organizationId,
        id: persisted.id,
        expectedRevision: originalRevision,
        state: withYear,
        pendingInput: null,
        latestAgentExecutionId: agentExecutionId,
        turnId: "skill-db-turn-3"
      })
    ).rejects.toBeInstanceOf(SkillExecutionRevisionConflictError);
  });

  it("durably preserves and corrects multi-turn canonical state without reviving an archived conversation", async () => {
    const conversation = await prisma.conversation.create({
      data: { organizationId, pluginInstallationId, title: "Durable multi-turn validation" }
    });
    const agentExecution = await prisma.agentExecution.create({
      data: {
        organizationId,
        pluginInstallationId,
        conversationId: conversation.id,
        status: AgentExecutionStatus.COMPLETED,
        requestId: "durable-turn-1"
      }
    });
    const service = new SkillExecutionService(prisma);
    const destinationFirst = decidePlanTripTurn(emptyPlanTripSkillState(), {
      data: { destination: { value: "Dubai", source: "USER_EXPLICIT" } }
    }).decision.state;
    const created = await service.createExecution({
      scope: {
        organizationId,
        pluginInstallationId,
        conversationId: conversation.id,
        skillId: "travel.plan-trip"
      },
      skillVersion: "1.0.0",
      schemaVersion: 1,
      state: destinationFirst,
      pendingInput: destinationFirst.pendingInput,
      agentExecutionId: agentExecution.id,
      turnId: "durable-turn-1"
    });
    await prisma.agentExecution.update({
      where: { id: agentExecution.id },
      data: {
        metadata: {
          skillShadow: {
            skillId: "travel.plan-trip",
            skillVersion: "1.0.0",
            mode: "SHADOW",
            existingDecision: "ASK_FOR_INPUT",
            shadowDecision: "ASK_FOR_INPUT",
            agreement: true,
            reasonCodes: [],
            adapterWarnings: [],
            fieldCompleteness: {
              origin: false,
              destination: true,
              departureDay: false,
              departureMonth: false,
              departureYear: false,
              travellers: false,
              durationOrReturnDate: false
            },
            persistence: {
              executionId: created.execution.id,
              status: created.execution.status,
              revision: created.execution.revision,
              applied: true,
              idempotentReplay: false,
              warning: null
            }
          }
        }
      }
    });
    expect(destinationFirst.pendingInput).toBe("ORIGIN");

    const completePartial = decidePlanTripTurn(destinationFirst, {
      data: {
        origin: { value: "Delhi", source: "USER_EXPLICIT" },
        departureDate: {
          value: { value: "12 January", day: 12, month: 1, year: null },
          source: "USER_EXPLICIT"
        },
        duration: { value: { value: 4, unit: "NIGHTS" }, source: "USER_EXPLICIT" },
        travellers: { value: { total: 5 }, source: "USER_EXPLICIT" }
      }
    }).decision.state;
    const second = await service.updateExecutionState({
      organizationId,
      id: created.execution.id,
      expectedRevision: created.execution.revision,
      state: completePartial,
      pendingInput: completePartial.pendingInput,
      latestAgentExecutionId: agentExecution.id,
      turnId: "durable-turn-2"
    });
    expect(completePartial.pendingInput).toBe("TRAVEL_YEAR");

    const withYear = decidePlanTripTurn(
      PlanTripSkillExecutionMapper.fromJson(second.execution.state),
      {
        data: {
          departureDate: {
            value: { value: "2027", day: null, month: null, year: 2027 },
            source: "USER_EXPLICIT"
          }
        }
      }
    ).decision.state;
    const third = await service.updateExecutionState({
      organizationId,
      id: created.execution.id,
      expectedRevision: second.execution.revision,
      state: withYear,
      pendingInput: withYear.pendingInput,
      latestAgentExecutionId: agentExecution.id,
      turnId: "durable-turn-3"
    });
    expect(withYear).toMatchObject({
      origin: "Delhi",
      destination: "Dubai",
      departureDate: { day: 12, month: 1, year: 2027 },
      duration: { value: 4, unit: "NIGHTS" },
      travellers: { total: 5, adults: null, children: null, infants: null },
      pendingInput: "TRAVELLER_COMPOSITION",
      lifecycleStatus: "COLLECTING_INPUT"
    });

    const corrected = decidePlanTripTurn(
      PlanTripSkillExecutionMapper.fromJson(third.execution.state),
      {
        data: {
          destination: { value: "Abu Dhabi", source: "USER_EXPLICIT" },
          travellers: {
            value: { adults: 3, children: 2, infants: 0 },
            source: "USER_EXPLICIT"
          },
          duration: { value: { value: 6, unit: "DAYS" }, source: "USER_EXPLICIT" }
        }
      }
    ).decision.state;
    const fourth = await service.updateExecutionState({
      organizationId,
      id: created.execution.id,
      expectedRevision: third.execution.revision,
      state: corrected,
      pendingInput: corrected.pendingInput,
      latestAgentExecutionId: agentExecution.id,
      turnId: "same-visible-text"
    });
    expect(corrected).toMatchObject({
      origin: "Delhi",
      destination: "Abu Dhabi",
      departureDate: { day: 12, month: 1, year: 2027 },
      duration: { value: 6, unit: "DAYS" },
      travellers: { total: 5, adults: 3, children: 2, infants: 0 }
    });

    const replay = await service.updateExecutionState({
      organizationId,
      id: created.execution.id,
      expectedRevision: fourth.execution.revision,
      state: corrected,
      pendingInput: corrected.pendingInput,
      latestAgentExecutionId: agentExecution.id,
      turnId: "same-visible-text"
    });
    expect(replay).toMatchObject({ applied: false, idempotentReplay: true });
    const distinctTurn = await service.updateExecutionState({
      organizationId,
      id: created.execution.id,
      expectedRevision: fourth.execution.revision,
      state: corrected,
      pendingInput: corrected.pendingInput,
      latestAgentExecutionId: agentExecution.id,
      turnId: "different-turn-same-user-text"
    });
    expect(distinctTurn).toMatchObject({ applied: true, idempotentReplay: false });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: ConversationStatus.ARCHIVED }
    });
    await expect(
      service.findActiveExecution({
        organizationId,
        pluginInstallationId,
        conversationId: conversation.id,
        skillId: "travel.plan-trip"
      })
    ).resolves.toBeNull();
    const cancelled = await service.markCancelled({
      organizationId,
      id: created.execution.id,
      expectedRevision: distinctTurn.execution.revision,
      latestAgentExecutionId: agentExecution.id,
      completionReason: "CONVERSATION_ARCHIVED"
    });
    expect(cancelled.status).toBe("CANCELLED");

    const diagnostics = new PlanTripSkillDiagnosticsService(prisma);
    const summary = await diagnostics.summary(organizationId, {
      limit: 100,
      pluginInstallationId
    });
    expect(summary.totalDistinctSkillExecutions).toBeGreaterThanOrEqual(1);
    expect(summary.totalApplicableEvaluations).toBeGreaterThanOrEqual(1);
    const detail = await diagnostics.execution(organizationId, created.execution.id);
    expect(detail.timeline).toEqual([
      expect.objectContaining({
        agentExecutionId: agentExecution.id,
        agreement: true,
        fieldCompleteness: expect.objectContaining({ destination: true, origin: false })
      })
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/Delhi|Dubai|Abu Dhabi|phone|email|budget|state/i);
    await expect(
      diagnostics.execution("00000000-0000-0000-0000-000000000000", created.execution.id)
    ).rejects.toThrow("SKILL_EXECUTION_NOT_FOUND");
  });
});
