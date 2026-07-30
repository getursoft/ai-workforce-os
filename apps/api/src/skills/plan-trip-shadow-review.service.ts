import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AgentMemoryScope, type Prisma, type SkillExecutionStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  type BlockingIssue,
  type CapabilityAgreement,
  type ConversationSummary,
  type CreatePlanTripReviewSessionDto,
  type ExecutionSummary,
  type PlanTripReviewRuntimeMode,
  type PlanTripReviewSessionStatus,
  type PlanTripRolloutRecommendation,
  type PolicyIssue,
  type ReviewSessionDto,
  type ReviewTurnDiagnostic,
  type RolloutSummary,
  type TrendSummary
} from "./plan-trip-shadow-review.dto";
import {
  planTripRuntimeMode,
  readPlanTripShadowComparison
} from "./plan-trip-skill-diagnostics.service";
import { PLAN_TRIP_SKILL_ID } from "./travel/plan-trip.skill";
import {
  classifyPlanTripReason,
  type PlanTripDiagnosticReason,
  type PlanTripRolloutClassification
} from "./travel/plan-trip-rollout-policy";

const REVIEW_KEY_PREFIX = "skill.review.travel-plan-trip.";
const REVIEW_SCHEMA_VERSION = 1;
const ACCEPTABLE_AGREEMENT_PERCENTAGE = 95;
const MAX_CANDIDATE_TURNS = 10_000;
const SAMPLE_PAGE_SIZE = 500;
const REVIEW_DIAGNOSTIC_SIGNALS = [
  "CROSS_TURN_STATE_LOSS",
  "CORRECTION_OVERWROTE_UNRELATED_FIELDS",
  "SKILL_STATE_VALIDATION_FAILED"
] as const satisfies readonly PlanTripDiagnosticReason[];

interface StoredReviewSession {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  reviewer: string;
  notes: string | null;
  status: PlanTripReviewSessionStatus;
  filters: {
    from: string;
    to: string;
    pluginInstallationId: string;
    runtimeMode: PlanTripReviewRuntimeMode;
    conversationCount: number;
    turnCount: number;
  };
  sampledConversationIds: string[];
  sampledAgentExecutionIds: string[];
}

interface SessionRow {
  id: string;
  value: Prisma.JsonValue;
}

interface SampledAgentRow {
  id: string;
  conversationId: string;
  modelProvider: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

interface SampledSkillRow {
  id: string;
  conversationId: string;
  status: SkillExecutionStatus;
  revision: number;
  pendingInput: string | null;
}

@Injectable()
export class PlanTripShadowReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(
    organizationId: string,
    reviewer: string,
    input: CreatePlanTripReviewSessionDto
  ): Promise<ReviewSessionDto> {
    if (new Date(input.from) > new Date(input.to))
      throw new BadRequestException("INVALID_REVIEW_DATE_RANGE");
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: input.pluginInstallationId, organizationId, deletedAt: null },
      select: { id: true }
    });
    if (!plugin) throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
    const now = new Date().toISOString();
    const session: StoredReviewSession = {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      sessionId: randomUUID(),
      createdAt: now,
      startedAt: null,
      completedAt: null,
      reviewer,
      notes: input.notes?.trim() || null,
      status: "CREATED",
      filters: {
        from: input.from,
        to: input.to,
        pluginInstallationId: input.pluginInstallationId,
        runtimeMode: input.runtimeMode,
        conversationCount: input.conversationCount,
        turnCount: input.turnCount
      },
      sampledConversationIds: [],
      sampledAgentExecutionIds: []
    };
    await this.prisma.agentMemory.create({
      data: {
        organizationId,
        pluginInstallationId: input.pluginInstallationId,
        userId: null,
        conversationId: null,
        scope: AgentMemoryScope.PLUGIN,
        key: `${REVIEW_KEY_PREFIX}${session.sessionId}`,
        value: session as unknown as Prisma.InputJsonValue,
        metadata: {
          kind: "TRAVEL_PLAN_TRIP_SHADOW_REVIEW",
          schemaVersion: REVIEW_SCHEMA_VERSION
        }
      }
    });
    return reviewSessionDto(session);
  }

  async startSession(organizationId: string, sessionId: string): Promise<ReviewSessionDto> {
    const loaded = await this.load(organizationId, sessionId);
    if (loaded.session.status === "ARCHIVED")
      throw new BadRequestException("REVIEW_SESSION_ARCHIVED");
    if (loaded.session.status !== "CREATED") return reviewSessionDto(loaded.session);
    const sample = await this.sample(organizationId, loaded.session);
    const next: StoredReviewSession = {
      ...loaded.session,
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      sampledConversationIds: sample.conversationIds,
      sampledAgentExecutionIds: sample.agentExecutionIds
    };
    await this.save(organizationId, loaded.row.id, next);
    return reviewSessionDto(next);
  }

  async completeSession(organizationId: string, sessionId: string): Promise<ReviewSessionDto> {
    const loaded = await this.load(organizationId, sessionId);
    if (loaded.session.status !== "RUNNING")
      throw new BadRequestException("REVIEW_SESSION_NOT_RUNNING");
    const next = {
      ...loaded.session,
      status: "COMPLETED" as const,
      completedAt: new Date().toISOString()
    };
    await this.save(organizationId, loaded.row.id, next);
    return reviewSessionDto(next);
  }

  async archiveSession(organizationId: string, sessionId: string): Promise<ReviewSessionDto> {
    const loaded = await this.load(organizationId, sessionId);
    const next = { ...loaded.session, status: "ARCHIVED" as const };
    await this.save(organizationId, loaded.row.id, next);
    return reviewSessionDto(next);
  }

  async getSession(organizationId: string, sessionId: string): Promise<ReviewSessionDto> {
    return reviewSessionDto((await this.load(organizationId, sessionId)).session);
  }

  async report(organizationId: string, sessionId: string): Promise<RolloutSummary> {
    const { session } = await this.load(organizationId, sessionId);
    if (session.status === "CREATED") throw new BadRequestException("REVIEW_SESSION_NOT_STARTED");
    const rows = await this.prisma.agentExecution.findMany({
      where: {
        organizationId,
        id: { in: session.sampledAgentExecutionIds },
        pluginInstallationId: session.filters.pluginInstallationId
      },
      select: {
        id: true,
        conversationId: true,
        modelProvider: true,
        metadata: true,
        createdAt: true
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    const turns = rows.flatMap((row) => {
      const comparison = readPlanTripShadowComparison(row.metadata);
      if (!comparison || comparison.existingDecision === "NOT_APPLICABLE") return [];
      return [toReviewTurn(row, comparison)];
    });
    const executionIds = [...new Set(turns.flatMap((turn) => turn.persistenceExecutionId ?? []))];
    const skillRows = executionIds.length
      ? await this.prisma.skillExecution.findMany({
          where: {
            organizationId,
            id: { in: executionIds },
            pluginInstallationId: session.filters.pluginInstallationId,
            skillId: PLAN_TRIP_SKILL_ID
          },
          select: {
            id: true,
            conversationId: true,
            status: true,
            revision: true,
            pendingInput: true
          }
        })
      : [];
    return buildRolloutSummary(session, turns, skillRows);
  }

  private async sample(
    organizationId: string,
    session: StoredReviewSession
  ): Promise<{ conversationIds: string[]; agentExecutionIds: string[] }> {
    const modeWhere = runtimeModeWhere(session.filters.runtimeMode);
    const conversationIds: string[] = [];
    const conversationSet = new Set<string>();
    const agentExecutionIds: string[] = [];
    let cursor: string | null = null;
    let scanned = 0;
    while (scanned < MAX_CANDIDATE_TURNS && agentExecutionIds.length < session.filters.turnCount) {
      const take = Math.min(SAMPLE_PAGE_SIZE, MAX_CANDIDATE_TURNS - scanned);
      const rows: SampledAgentRow[] = await this.prisma.agentExecution.findMany({
        where: {
          organizationId,
          pluginInstallationId: session.filters.pluginInstallationId,
          createdAt: { gte: new Date(session.filters.from), lte: new Date(session.filters.to) },
          ...modeWhere
        },
        select: {
          id: true,
          conversationId: true,
          modelProvider: true,
          metadata: true,
          createdAt: true
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      scanned += rows.length;
      for (const row of rows) {
        const comparison = readPlanTripShadowComparison(row.metadata);
        if (!comparison || comparison.existingDecision === "NOT_APPLICABLE") continue;
        if (!conversationSet.has(row.conversationId)) {
          if (conversationSet.size >= session.filters.conversationCount) continue;
          conversationSet.add(row.conversationId);
          conversationIds.push(row.conversationId);
        }
        if (!conversationSet.has(row.conversationId)) continue;
        agentExecutionIds.push(row.id);
        if (agentExecutionIds.length >= session.filters.turnCount) break;
      }
      if (rows.length < take) break;
      cursor = rows.at(-1)?.id ?? null;
      if (!cursor) break;
    }
    return { conversationIds, agentExecutionIds };
  }

  private async load(
    organizationId: string,
    sessionId: string
  ): Promise<{ row: SessionRow; session: StoredReviewSession }> {
    const row = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        scope: AgentMemoryScope.PLUGIN,
        key: `${REVIEW_KEY_PREFIX}${sessionId}`,
        deletedAt: null
      },
      select: { id: true, value: true }
    });
    if (!row) throw new NotFoundException("REVIEW_SESSION_NOT_FOUND");
    return { row, session: parseSession(row.value) };
  }

  private async save(
    organizationId: string,
    rowId: string,
    session: StoredReviewSession
  ): Promise<void> {
    const updated = await this.prisma.agentMemory.updateMany({
      where: { id: rowId, organizationId, deletedAt: null },
      data: { value: session as unknown as Prisma.InputJsonValue }
    });
    if (updated.count !== 1) throw new NotFoundException("REVIEW_SESSION_NOT_FOUND");
  }
}

export function recommendPlanTripRollout(input: {
  conversationCount: number;
  blockingCount: number;
  stateLossCount: number;
  unexpectedOverwriteCount: number;
  agreementPercentage: number;
}): PlanTripRolloutRecommendation {
  if (input.blockingCount > 0 || input.stateLossCount > 0 || input.unexpectedOverwriteCount > 0)
    return "NOT_READY";
  if (input.conversationCount < 100) return "READY_FOR_MORE_UAT";
  if (input.agreementPercentage >= ACCEPTABLE_AGREEMENT_PERCENTAGE)
    return "READY_FOR_LIMITED_ROLLOUT";
  return "READY_FOR_MORE_UAT";
}

function buildRolloutSummary(
  session: StoredReviewSession,
  turns: ReviewTurnDiagnostic[],
  skillRows: SampledSkillRow[]
): RolloutSummary {
  const byConversation = groupBy(turns, (turn) => turn.conversationId);
  const skillByConversation = groupBy(skillRows, (row) => row.conversationId);
  const conversations = [...byConversation.entries()].map(([conversationId, items]) =>
    buildConversationSummary(conversationId, items, skillByConversation.get(conversationId) ?? [])
  );
  const issueMap = collectIssues(turns, conversations);
  const blockingIssues = issueDtos(issueMap, "BLOCKING") as BlockingIssue[];
  const policyIssues = [
    ...issueDtos(issueMap, "PRODUCT_POLICY_REVIEW"),
    ...issueDtos(issueMap, "EXPECTED_NON_EQUIVALENCE")
  ] as PolicyIssue[];
  const agreementCount = turns.filter((turn) => turn.agreement).length;
  const capabilityAgreement = capabilitySummary(turns);
  const blockingCount = turns.filter((turn) => hasClassification(turn, "BLOCKING")).length;
  const policyCount = turns.filter((turn) =>
    hasClassification(turn, "PRODUCT_POLICY_REVIEW")
  ).length;
  const expectedNonEquivalenceCount = turns.filter((turn) =>
    hasClassification(turn, "EXPECTED_NON_EQUIVALENCE")
  ).length;
  const stateLossCount = conversations.filter((item) => item.stateLoss).length;
  const unexpectedOverwriteCount = conversations.filter((item) => item.unexpectedOverwrite).length;
  const trends = trendSummary(turns, conversations, skillRows);
  return {
    reviewSession: reviewSessionDto(session),
    conversationCount: conversations.length,
    turnCount: turns.length,
    agreementCount,
    disagreementCount: turns.length - agreementCount,
    blockingCount,
    policyCount,
    expectedNonEquivalenceCount,
    adapterWarningCount: turns.filter((turn) => turn.adapterWarnings.length > 0).length,
    revisionConflictCount: turns.filter((turn) =>
      turn.reasonCodes.includes("SKILL_REVISION_CONFLICT")
    ).length,
    stateLossCount,
    unexpectedOverwriteCount,
    capabilityAgreement,
    blockingIssues,
    policyIssues,
    trends,
    recommendation: recommendPlanTripRollout({
      conversationCount: conversations.length,
      blockingCount,
      stateLossCount,
      unexpectedOverwriteCount,
      agreementPercentage: trends.overallAgreementPercentage
    }),
    conversations
  };
}

function buildConversationSummary(
  conversationId: string,
  turns: ReviewTurnDiagnostic[],
  skillRows: SampledSkillRow[]
): ConversationSummary {
  const executionGroups = groupBy(
    turns.filter((turn) => turn.persistenceExecutionId),
    (turn) => turn.persistenceExecutionId as string
  );
  const rowsById = new Map(skillRows.map((row) => [row.id, row]));
  const executions = [...executionGroups.entries()].map(([id, items]) =>
    buildExecutionSummary(id, items, rowsById.get(id))
  );
  const runtimeModes = new Set(turns.map((turn) => turn.runtimeMode));
  const stateLoss = executions.some((execution) => execution.stateLoss);
  const unexpectedOverwrite = executions.some((execution) => execution.unexpectedOverwrite);
  const blockingDisagreement = turns.some((turn) => hasClassification(turn, "BLOCKING"));
  const policyDisagreement = turns.some((turn) => hasClassification(turn, "PRODUCT_POLICY_REVIEW"));
  const expectedNonEquivalence = turns.some((turn) =>
    hasClassification(turn, "EXPECTED_NON_EQUIVALENCE")
  );
  return {
    conversationId,
    runtimeMode:
      runtimeModes.size > 1
        ? "MIXED"
        : (([...runtimeModes][0] ?? "UNKNOWN") as ConversationSummary["runtimeMode"]),
    turnCount: turns.length,
    agreement: turns.every((turn) => turn.agreement),
    agreementCount: turns.filter((turn) => turn.agreement).length,
    disagreementCount: turns.filter((turn) => !turn.agreement).length,
    blockingDisagreement,
    policyDisagreement,
    expectedNonEquivalence,
    revisionConflict: turns.some((turn) => turn.reasonCodes.includes("SKILL_REVISION_CONFLICT")),
    adapterWarnings: unique(turns.flatMap((turn) => turn.adapterWarnings)),
    stateLoss,
    unexpectedOverwrite,
    capabilityMismatch: turns.some((turn) => turn.capabilityAgreement === false),
    completionPath: uniqueInOrder(turns.flatMap((turn) => turn.persistenceStatus ?? [])),
    pendingInputHistory: turns.flatMap((turn) => turn.pendingInput ?? []),
    executions
  };
}

function buildExecutionSummary(
  id: string,
  turns: ReviewTurnDiagnostic[],
  row: SampledSkillRow | undefined
): ExecutionSummary {
  const stateLoss =
    hasCompletenessRegression(turns.map((turn) => turn.fieldCompleteness)) ||
    turns.some((turn) => hasDiagnosticSignal(turn, "CROSS_TURN_STATE_LOSS"));
  const unexpectedOverwrite = turns.some((turn) =>
    hasDiagnosticSignal(turn, "CORRECTION_OVERWROTE_UNRELATED_FIELDS")
  );
  return {
    skillExecutionId: id,
    status: row?.status ?? turns.at(-1)?.persistenceStatus ?? "UNKNOWN",
    revision: row?.revision ?? turns.at(-1)?.persistenceRevision ?? 0,
    turnCount: turns.length,
    pendingInputHistory: turns.flatMap((turn) => turn.pendingInput ?? []),
    completionPath: uniqueInOrder([
      ...turns.flatMap((turn) => turn.persistenceStatus ?? []),
      ...(row ? [row.status] : [])
    ]),
    revisionConflict: turns.some((turn) => turn.reasonCodes.includes("SKILL_REVISION_CONFLICT")),
    adapterWarnings: unique(turns.flatMap((turn) => turn.adapterWarnings)),
    stateLoss,
    unexpectedOverwrite,
    capabilityMismatch: turns.some((turn) => turn.capabilityAgreement === false)
  };
}

function trendSummary(
  turns: ReviewTurnDiagnostic[],
  conversations: ConversationSummary[],
  skillRows: SampledSkillRow[]
): TrendSummary {
  const count = turns.length;
  const conversationCount = conversations.length;
  const percent = (value: number, denominator = count) =>
    denominator ? Number(((value / denominator) * 100).toFixed(2)) : 0;
  return {
    overallAgreementPercentage: percent(turns.filter((turn) => turn.agreement).length),
    blockingPercentage: percent(turns.filter((turn) => hasClassification(turn, "BLOCKING")).length),
    policyPercentage: percent(
      turns.filter((turn) => hasClassification(turn, "PRODUCT_POLICY_REVIEW")).length
    ),
    adapterPercentage: percent(turns.filter((turn) => turn.adapterWarnings.length > 0).length),
    revisionConflictPercentage: percent(
      turns.filter((turn) => turn.reasonCodes.includes("SKILL_REVISION_CONFLICT")).length
    ),
    stateLossPercentage: percent(
      conversations.filter((item) => item.stateLoss).length,
      conversationCount
    ),
    overwritePercentage: percent(
      conversations.filter((item) => item.unexpectedOverwrite).length,
      conversationCount
    ),
    runtimeModeSplit: {
      deterministicTurns: turns.filter((turn) => turn.runtimeMode === "DETERMINISTIC").length,
      llmTurns: turns.filter((turn) => turn.runtimeMode === "LLM").length,
      unknownTurns: turns.filter((turn) => turn.runtimeMode === "UNKNOWN").length
    },
    averageTurnsPerConversation: average(count, conversationCount),
    averagePendingInputsPerConversation: average(
      conversations.reduce((sum, item) => sum + item.pendingInputHistory.length, 0),
      conversationCount
    ),
    averageRevisionsPerConversation: average(
      skillRows.reduce((sum, row) => sum + row.revision, 0),
      conversationCount
    )
  };
}

function capabilitySummary(turns: ReviewTurnDiagnostic[]): CapabilityAgreement {
  const evaluated = turns.filter((turn) => turn.capabilityAgreement !== null);
  const agreements = evaluated.filter((turn) => turn.capabilityAgreement).length;
  return {
    evaluated: evaluated.length,
    agreements,
    mismatches: evaluated.length - agreements,
    agreementPercentage: evaluated.length
      ? Number(((agreements / evaluated.length) * 100).toFixed(2))
      : 0,
    shadowCapabilityTrueCounts: {
      itinerary: turns.filter((turn) => turn.shadowCapabilities.itinerary).length,
      estimate: turns.filter((turn) => turn.shadowCapabilities.estimate).length,
      liveSearch: turns.filter((turn) => turn.shadowCapabilities.liveSearch).length,
      booking: turns.filter((turn) => turn.shadowCapabilities.booking).length
    }
  };
}

function collectIssues(
  turns: ReviewTurnDiagnostic[],
  conversations: ConversationSummary[]
): Map<PlanTripDiagnosticReason, { turns: number; conversations: Set<string> }> {
  const result = new Map<PlanTripDiagnosticReason, { turns: number; conversations: Set<string> }>();
  const add = (code: PlanTripDiagnosticReason, conversationId: string, turn = true) => {
    const current = result.get(code) ?? { turns: 0, conversations: new Set<string>() };
    if (turn) current.turns += 1;
    current.conversations.add(conversationId);
    result.set(code, current);
  };
  for (const turn of turns)
    for (const reason of [...turn.reasonCodes, ...turn.diagnosticSignals])
      add(reason, turn.conversationId);
  for (const conversation of conversations) {
    if (conversation.stateLoss) add("CROSS_TURN_STATE_LOSS", conversation.conversationId, false);
    if (conversation.unexpectedOverwrite)
      add("CORRECTION_OVERWROTE_UNRELATED_FIELDS", conversation.conversationId, false);
  }
  return result;
}

function issueDtos(
  issues: Map<PlanTripDiagnosticReason, { turns: number; conversations: Set<string> }>,
  classification: PlanTripRolloutClassification
): Array<BlockingIssue | PolicyIssue> {
  return [...issues.entries()]
    .filter(([code]) => classifyPlanTripReason(code) === classification)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, value]) => ({
      code,
      classification,
      turnCount: value.turns,
      conversationCount: value.conversations.size
    })) as Array<BlockingIssue | PolicyIssue>;
}

function hasClassification(
  turn: ReviewTurnDiagnostic,
  classification: PlanTripRolloutClassification
): boolean {
  return [...turn.reasonCodes, ...turn.diagnosticSignals].some(
    (reason) => classifyPlanTripReason(reason) === classification
  );
}

function hasCompletenessRegression(values: object[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1] as Record<string, boolean>;
    const current = values[index] as Record<string, boolean>;
    for (const [field, complete] of Object.entries(previous))
      if (complete && current[field] === false) return true;
  }
  return false;
}

function hasDiagnosticSignal(
  turn: ReviewTurnDiagnostic,
  signal: PlanTripDiagnosticReason
): boolean {
  return turn.diagnosticSignals.includes(signal);
}

function toReviewTurn(
  row: SampledAgentRow,
  comparison: NonNullable<ReturnType<typeof readPlanTripShadowComparison>>
): ReviewTurnDiagnostic {
  return {
    agentExecutionId: row.id,
    conversationId: row.conversationId,
    runtimeMode: planTripRuntimeMode(row.modelProvider),
    agreement: comparison.agreement,
    capabilityAgreement: comparison.capabilityAgreement,
    shadowCapabilities: comparison.shadowCapabilities,
    reasonCodes: comparison.reasonCodes,
    diagnosticSignals: readDiagnosticSignals(row.metadata),
    adapterWarnings: comparison.adapterWarnings,
    pendingInput: comparison.shadowMissingField,
    persistenceExecutionId: comparison.persistence?.executionId ?? null,
    persistenceStatus: comparison.persistence?.status ?? null,
    persistenceRevision: comparison.persistence?.revision ?? null,
    fieldCompleteness: comparison.fieldCompleteness
  };
}

function readDiagnosticSignals(metadata: Prisma.JsonValue): PlanTripDiagnosticReason[] {
  if (!isRecord(metadata) || !isRecord(metadata.skillShadow)) return [];
  const value = metadata.skillShadow.diagnosticSignals;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (signal): signal is PlanTripDiagnosticReason =>
      typeof signal === "string" && REVIEW_DIAGNOSTIC_SIGNALS.includes(signal as never)
  );
}

function runtimeModeWhere(mode: PlanTripReviewRuntimeMode): Prisma.AgentExecutionWhereInput {
  if (mode === "DETERMINISTIC") return { modelProvider: "travel-employee" };
  if (mode === "LLM") return { modelProvider: { not: null, notIn: ["travel-employee"] } };
  return {};
}

function reviewSessionDto(session: StoredReviewSession): ReviewSessionDto {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    reviewer: session.reviewer,
    notes: session.notes ? "[REDACTED_OPERATIONAL_NOTES]" : null,
    status: session.status,
    filters: session.filters,
    sampledConversationCount: session.sampledConversationIds.length,
    sampledTurnCount: session.sampledAgentExecutionIds.length
  };
}

function parseSession(value: Prisma.JsonValue): StoredReviewSession {
  if (!isRecord(value) || value.schemaVersion !== REVIEW_SCHEMA_VERSION)
    throw new BadRequestException("INVALID_REVIEW_SESSION");
  const status = value.status;
  const filters = value.filters;
  if (
    typeof value.sessionId !== "string" ||
    typeof value.createdAt !== "string" ||
    !isNullableString(value.startedAt) ||
    !isNullableString(value.completedAt) ||
    typeof value.reviewer !== "string" ||
    !isNullableString(value.notes) ||
    !isReviewStatus(status) ||
    !isRecord(filters) ||
    typeof filters.from !== "string" ||
    typeof filters.to !== "string" ||
    typeof filters.pluginInstallationId !== "string" ||
    !isRuntimeMode(filters.runtimeMode) ||
    !positiveInteger(filters.conversationCount) ||
    !positiveInteger(filters.turnCount) ||
    !stringArray(value.sampledConversationIds) ||
    !stringArray(value.sampledAgentExecutionIds)
  )
    throw new BadRequestException("INVALID_REVIEW_SESSION");
  return value as unknown as StoredReviewSession;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isReviewStatus(value: unknown): value is PlanTripReviewSessionStatus {
  return ["CREATED", "RUNNING", "COMPLETED", "ARCHIVED"].includes(value as string);
}

function isRuntimeMode(value: unknown): value is PlanTripReviewRuntimeMode {
  return ["ALL", "DETERMINISTIC", "LLM"].includes(value as string);
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) result.set(key(item), [...(result.get(key(item)) ?? []), item]);
  return result;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueInOrder<T>(items: T[]): T[] {
  return items.filter((item, index) => index === 0 || items[index - 1] !== item);
}

function average(total: number, count: number): number {
  return count ? Number((total / count).toFixed(2)) : 0;
}
