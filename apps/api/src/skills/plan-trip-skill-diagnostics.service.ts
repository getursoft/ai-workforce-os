import { Injectable, NotFoundException } from "@nestjs/common";
import { SkillExecutionStatus, type Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PlanTripSkillDiagnosticQueryDto } from "./skill-diagnostics.dto";
import { PLAN_TRIP_SKILL_ID, PLAN_TRIP_SKILL_VERSION } from "./travel/plan-trip.skill";
import type { PlanTripReadinessCapabilities } from "./travel/plan-trip.skill";
import type {
  PlanTripAdapterWarning,
  PlanTripFieldCompleteness,
  PlanTripShadowComparison,
  SkillShadowDecisionCategory,
  SkillShadowDisagreementReason
} from "./travel/plan-trip-shadow-comparison";
import {
  classifyPlanTripReason,
  type PlanTripDiagnosticReason,
  type PlanTripRolloutClassification
} from "./travel/plan-trip-rollout-policy";
import { PlanTripSkillExecutionMapper } from "./travel/plan-trip-skill-execution.mapper";

const UNUSUALLY_MANY_WAITING_TURNS = 5;

export interface PlanTripDiagnosticSummary {
  skillId: typeof PLAN_TRIP_SKILL_ID;
  skillVersion: typeof PLAN_TRIP_SKILL_VERSION;
  from: string | null;
  to: string | null;
  boundedLimit: number;
  totalApplicableEvaluations: number;
  totalDistinctSkillExecutions: number;
  agreements: number;
  disagreements: number;
  agreementPercentage: number;
  capabilityAgreements: number;
  capabilityDisagreements: number;
  capabilityAgreementPercentage: number;
  disagreementCountsByReason: Partial<Record<SkillShadowDisagreementReason, number>>;
  decisionPairCounts: Record<string, number>;
  classificationCounts: Record<PlanTripRolloutClassification, number>;
  diagnosticSignalCounts: Partial<Record<PlanTripDiagnosticReason, number>>;
  stateValidationFailureCount: number;
  persistenceFailureCount: number;
  revisionConflictCount: number;
  adapterWarningCounts: Partial<Record<PlanTripAdapterWarning, number>>;
  statusDistribution: Partial<Record<SkillExecutionStatus, number>>;
  pendingInputDistribution: Record<string, number>;
  runtimeModeCounts: { deterministic: number; llm: number; unknown: number };
  executionsWithRepeatedDisagreement: number;
  executionsWaitingUnusuallyManyTurns: number;
  executionsReachingReady: number;
  executionsCompleted: number;
  executionsCancelled: number;
  executionsFailed: number;
}

export interface PlanTripDiagnosticTimelineItem {
  agentExecutionId: string;
  createdAt: string;
  runtimeMode: "DETERMINISTIC" | "LLM" | "UNKNOWN";
  existingDecision: SkillShadowDecisionCategory;
  shadowDecision: SkillShadowDecisionCategory;
  agreement: boolean;
  capabilityAgreement: boolean | null;
  shadowCapabilities: PlanTripReadinessCapabilities;
  reasonCodes: SkillShadowDisagreementReason[];
  adapterWarnings: PlanTripAdapterWarning[];
  persistenceWarning: "SKILL_PERSISTENCE_FAILED" | "SKILL_REVISION_CONFLICT" | null;
  fieldCompleteness: PlanTripFieldCompleteness;
}

export interface PlanTripExecutionDiagnostic {
  skillExecutionId: string;
  skillId: string;
  skillVersion: string;
  schemaVersion: number;
  lifecycleStatus: SkillExecutionStatus;
  revision: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  processedTurnCount: number;
  pendingInput: string | null;
  timeline: PlanTripDiagnosticTimelineItem[];
}

@Injectable()
export class PlanTripSkillDiagnosticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    organizationId: string,
    query: PlanTripSkillDiagnosticQueryDto
  ): Promise<PlanTripDiagnosticSummary> {
    const range = dateRange(query);
    const executionWhere: Prisma.AgentExecutionWhereInput = {
      organizationId,
      ...(query.pluginInstallationId ? { pluginInstallationId: query.pluginInstallationId } : {}),
      ...(range ? { createdAt: range } : {})
    };
    const skillWhere: Prisma.SkillExecutionWhereInput = {
      organizationId,
      skillId: PLAN_TRIP_SKILL_ID,
      ...(query.pluginInstallationId ? { pluginInstallationId: query.pluginInstallationId } : {}),
      ...(range ? { startedAt: range } : {})
    };
    const [agentRows, skillRows] = await Promise.all([
      this.prisma.agentExecution.findMany({
        where: executionWhere,
        select: { id: true, modelProvider: true, metadata: true },
        orderBy: { createdAt: "desc" },
        take: query.limit
      }),
      this.prisma.skillExecution.findMany({
        where: skillWhere,
        select: {
          id: true,
          status: true,
          pendingInput: true,
          processedTurnIds: true,
          state: true
        },
        orderBy: { startedAt: "desc" },
        take: query.limit
      })
    ]);
    const comparisons = agentRows.flatMap((row) => {
      const comparison = readPlanTripShadowComparison(row.metadata);
      return comparison
        ? [{ ...comparison, agentExecutionId: row.id, modelProvider: row.modelProvider }]
        : [];
    });
    const applicable = comparisons.filter((item) => item.existingDecision !== "NOT_APPLICABLE");
    const disagreementsByExecution = new Map<string, number>();
    const result: PlanTripDiagnosticSummary = {
      skillId: PLAN_TRIP_SKILL_ID,
      skillVersion: PLAN_TRIP_SKILL_VERSION,
      from: query.from ?? null,
      to: query.to ?? null,
      boundedLimit: query.limit,
      totalApplicableEvaluations: applicable.length,
      totalDistinctSkillExecutions: skillRows.length,
      agreements: 0,
      disagreements: 0,
      agreementPercentage: 0,
      capabilityAgreements: 0,
      capabilityDisagreements: 0,
      capabilityAgreementPercentage: 0,
      disagreementCountsByReason: {},
      decisionPairCounts: {},
      classificationCounts: { BLOCKING: 0, PRODUCT_POLICY_REVIEW: 0, EXPECTED_NON_EQUIVALENCE: 0 },
      diagnosticSignalCounts: {},
      stateValidationFailureCount: 0,
      persistenceFailureCount: 0,
      revisionConflictCount: 0,
      adapterWarningCounts: {},
      statusDistribution: {},
      pendingInputDistribution: {},
      runtimeModeCounts: { deterministic: 0, llm: 0, unknown: 0 },
      executionsWithRepeatedDisagreement: 0,
      executionsWaitingUnusuallyManyTurns: 0,
      executionsReachingReady: 0,
      executionsCompleted: 0,
      executionsCancelled: 0,
      executionsFailed: 0
    };
    for (const item of comparisons) {
      if (item.existingDecision === "NOT_APPLICABLE")
        addSignal(result, "NON_PLANNING_NOT_APPLICABLE");
      if (item.existingDecision === "EXECUTING_TOOL" && item.shadowDecision === "READY_FOR_PLAN")
        addSignal(result, "TOOL_EXECUTION_WHILE_SHADOW_READY");
      if (
        item.existingDecision === "REQUEST_CONFIRMATION" &&
        item.shadowDecision === "READY_FOR_PLAN"
      )
        addSignal(result, "CONFIRMATION_TIMING_DIFFERENCE");
      if (item.existingDecision === "NOT_APPLICABLE") continue;
      if (item.agreement) result.agreements += 1;
      else result.disagreements += 1;
      if (item.capabilityAgreement === true) result.capabilityAgreements += 1;
      if (item.capabilityAgreement === false) result.capabilityDisagreements += 1;
      const pair = `${item.existingDecision}->${item.shadowDecision}`;
      result.decisionPairCounts[pair] = (result.decisionPairCounts[pair] ?? 0) + 1;
      for (const reason of item.reasonCodes) {
        result.disagreementCountsByReason[reason] =
          (result.disagreementCountsByReason[reason] ?? 0) + 1;
        addSignal(result, reason);
      }
      if (item.reasonCodes.includes("SKILL_PERSISTENCE_FAILED"))
        result.persistenceFailureCount += 1;
      if (item.reasonCodes.includes("SKILL_REVISION_CONFLICT")) result.revisionConflictCount += 1;
      for (const warning of item.adapterWarnings)
        result.adapterWarningCounts[warning] = (result.adapterWarningCounts[warning] ?? 0) + 1;
      const mode = planTripRuntimeMode(item.modelProvider);
      result.runtimeModeCounts[mode.toLowerCase() as "deterministic" | "llm" | "unknown"] += 1;
      if (!item.agreement && item.persistence?.executionId)
        disagreementsByExecution.set(
          item.persistence.executionId,
          (disagreementsByExecution.get(item.persistence.executionId) ?? 0) + 1
        );
    }
    result.agreementPercentage = applicable.length
      ? Number(((result.agreements / applicable.length) * 100).toFixed(2))
      : 0;
    const capabilityEvaluations = result.capabilityAgreements + result.capabilityDisagreements;
    result.capabilityAgreementPercentage = capabilityEvaluations
      ? Number(((result.capabilityAgreements / capabilityEvaluations) * 100).toFixed(2))
      : 0;
    result.executionsWithRepeatedDisagreement = [...disagreementsByExecution.values()].filter(
      (count) => count > 1
    ).length;
    for (const execution of skillRows) {
      result.statusDistribution[execution.status] =
        (result.statusDistribution[execution.status] ?? 0) + 1;
      if (execution.pendingInput)
        result.pendingInputDistribution[execution.pendingInput] =
          (result.pendingInputDistribution[execution.pendingInput] ?? 0) + 1;
      const turns = processedTurnCount(execution.processedTurnIds);
      if (
        execution.status === SkillExecutionStatus.WAITING_FOR_INPUT &&
        turns >= UNUSUALLY_MANY_WAITING_TURNS
      )
        result.executionsWaitingUnusuallyManyTurns += 1;
      if (execution.status === SkillExecutionStatus.READY) result.executionsReachingReady += 1;
      if (execution.status === SkillExecutionStatus.COMPLETED) result.executionsCompleted += 1;
      if (execution.status === SkillExecutionStatus.CANCELLED) result.executionsCancelled += 1;
      if (execution.status === SkillExecutionStatus.FAILED) result.executionsFailed += 1;
      try {
        const state = PlanTripSkillExecutionMapper.fromJson(execution.state);
        if (
          state.travellers.total !== null &&
          state.travellers.adults === null &&
          state.travellers.children === null &&
          state.travellers.infants === null
        )
          addSignal(result, "TOTAL_TRAVELLERS_WITHOUT_COMPOSITION");
        if (state.purpose === null) addSignal(result, "PURPOSE_MISSING");
        if (state.budget === null) addSignal(result, "BUDGET_MISSING");
      } catch {
        result.stateValidationFailureCount += 1;
        addSignal(result, "SKILL_STATE_VALIDATION_FAILED");
      }
    }
    return result;
  }

  async execution(organizationId: string, id: string): Promise<PlanTripExecutionDiagnostic> {
    const execution = await this.prisma.skillExecution.findFirst({
      where: { id, organizationId, skillId: PLAN_TRIP_SKILL_ID },
      select: {
        id: true,
        organizationId: true,
        conversationId: true,
        skillId: true,
        skillVersion: true,
        schemaVersion: true,
        status: true,
        revision: true,
        startedAt: true,
        updatedAt: true,
        completedAt: true,
        processedTurnIds: true,
        pendingInput: true
      }
    });
    if (!execution) throw new NotFoundException("SKILL_EXECUTION_NOT_FOUND");
    const agentRows = await this.prisma.agentExecution.findMany({
      where: { organizationId, conversationId: execution.conversationId },
      select: { id: true, createdAt: true, modelProvider: true, metadata: true },
      orderBy: { createdAt: "asc" },
      take: 1000
    });
    const timeline = agentRows.flatMap((row): PlanTripDiagnosticTimelineItem[] => {
      const comparison = readPlanTripShadowComparison(row.metadata);
      if (!comparison || comparison.persistence?.executionId !== execution.id) return [];
      return [
        {
          agentExecutionId: row.id,
          createdAt: row.createdAt.toISOString(),
          runtimeMode: planTripRuntimeMode(row.modelProvider),
          existingDecision: comparison.existingDecision,
          shadowDecision: comparison.shadowDecision,
          agreement: comparison.agreement,
          capabilityAgreement: comparison.capabilityAgreement,
          shadowCapabilities: comparison.shadowCapabilities,
          reasonCodes: comparison.reasonCodes,
          adapterWarnings: comparison.adapterWarnings,
          persistenceWarning: comparison.persistence?.warning ?? null,
          fieldCompleteness: comparison.fieldCompleteness
        }
      ];
    });
    return {
      skillExecutionId: execution.id,
      skillId: execution.skillId,
      skillVersion: execution.skillVersion,
      schemaVersion: execution.schemaVersion,
      lifecycleStatus: execution.status,
      revision: execution.revision,
      startedAt: execution.startedAt.toISOString(),
      updatedAt: execution.updatedAt.toISOString(),
      completedAt: execution.completedAt?.toISOString() ?? null,
      processedTurnCount: processedTurnCount(execution.processedTurnIds),
      pendingInput: execution.pendingInput,
      timeline
    };
  }
}

function addSignal(result: PlanTripDiagnosticSummary, reason: PlanTripDiagnosticReason): void {
  result.diagnosticSignalCounts[reason] = (result.diagnosticSignalCounts[reason] ?? 0) + 1;
  result.classificationCounts[classifyPlanTripReason(reason)] += 1;
}

function dateRange(query: PlanTripSkillDiagnosticQueryDto): Prisma.DateTimeFilter | null {
  if (!query.from && !query.to) return null;
  return {
    ...(query.from ? { gte: new Date(query.from) } : {}),
    ...(query.to ? { lte: new Date(query.to) } : {})
  };
}

function processedTurnCount(value: Prisma.JsonValue): number {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").length : 0;
}

export function planTripRuntimeMode(
  modelProvider: string | null
): "DETERMINISTIC" | "LLM" | "UNKNOWN" {
  if (modelProvider === "travel-employee") return "DETERMINISTIC";
  if (modelProvider) return "LLM";
  return "UNKNOWN";
}

export function readPlanTripShadowComparison(
  metadata: Prisma.JsonValue
): PlanTripShadowComparison | null {
  if (!isRecord(metadata) || !isRecord(metadata.skillShadow)) return null;
  const value = metadata.skillShadow;
  if (
    value.skillId !== PLAN_TRIP_SKILL_ID ||
    value.skillVersion !== PLAN_TRIP_SKILL_VERSION ||
    typeof value.agreement !== "boolean" ||
    !isDecision(value.existingDecision) ||
    !isDecision(value.shadowDecision) ||
    !isFieldCompleteness(value.fieldCompleteness)
  )
    return null;
  const reasonCodes = arrayOfKnown(value.reasonCodes, REASONS);
  const adapterWarnings = arrayOfKnown(value.adapterWarnings, WARNINGS);
  if (!reasonCodes || !adapterWarnings) return null;
  const persistence: PlanTripShadowComparison["persistence"] = isRecord(value.persistence)
    ? {
        executionId:
          typeof value.persistence.executionId === "string" ? value.persistence.executionId : null,
        status: typeof value.persistence.status === "string" ? value.persistence.status : null,
        revision:
          typeof value.persistence.revision === "number" ? value.persistence.revision : null,
        applied: value.persistence.applied === true,
        idempotentReplay: value.persistence.idempotentReplay === true,
        warning: (value.persistence.warning === "SKILL_PERSISTENCE_FAILED" ||
        value.persistence.warning === "SKILL_REVISION_CONFLICT"
          ? value.persistence.warning
          : null) as "SKILL_PERSISTENCE_FAILED" | "SKILL_REVISION_CONFLICT" | null
      }
    : undefined;
  const shadowCapabilities = isCapabilities(value.shadowCapabilities)
    ? value.shadowCapabilities
    : legacyCapabilities(value.shadowDecision);
  return {
    skillId: PLAN_TRIP_SKILL_ID,
    skillVersion: PLAN_TRIP_SKILL_VERSION,
    mode: "SHADOW",
    existingDecision: value.existingDecision,
    shadowDecision: value.shadowDecision,
    agreement: value.agreement,
    reasonCodes,
    existingMissingField: null,
    shadowMissingField: isPendingInput(value.shadowMissingField) ? value.shadowMissingField : null,
    existingReady: null,
    shadowReady: null,
    shadowCapabilities,
    capabilityAgreement:
      typeof value.capabilityAgreement === "boolean"
        ? value.capabilityAgreement
        : diagnosticCapabilityAgreement(value.existingDecision, shadowCapabilities),
    fieldCompleteness: value.fieldCompleteness,
    adapterWarnings,
    ...(persistence ? { persistence } : {})
  };
}

function legacyCapabilities(decision: SkillShadowDecisionCategory): PlanTripReadinessCapabilities {
  const ready = decision === "READY_FOR_PLAN";
  return { itinerary: ready, estimate: ready, liveSearch: ready, booking: ready };
}

function diagnosticCapabilityAgreement(
  decision: SkillShadowDecisionCategory,
  capabilities: PlanTripReadinessCapabilities
): boolean | null {
  if (decision === "READY_FOR_PLAN") return capabilities.itinerary;
  if (decision === "EXECUTING_TOOL") return capabilities.liveSearch;
  if (decision === "REQUEST_CONFIRMATION") return capabilities.booking;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is SkillShadowDecisionCategory {
  return typeof value === "string" && DECISIONS.includes(value as SkillShadowDecisionCategory);
}

function isFieldCompleteness(value: unknown): value is PlanTripFieldCompleteness {
  return (
    isRecord(value) &&
    FIELDS.every((field) => typeof value[field] === "boolean") &&
    Object.keys(value).every((field) => FIELDS.includes(field as keyof PlanTripFieldCompleteness))
  );
}

function isCapabilities(value: unknown): value is PlanTripReadinessCapabilities {
  return (
    isRecord(value) &&
    CAPABILITIES.every((capability) => typeof value[capability] === "boolean") &&
    Object.keys(value).every((key) =>
      CAPABILITIES.includes(key as keyof PlanTripReadinessCapabilities)
    )
  );
}

function isPendingInput(
  value: unknown
): value is NonNullable<PlanTripShadowComparison["shadowMissingField"]> {
  return typeof value === "string" && PENDING_INPUTS.includes(value as never);
}

function arrayOfKnown<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && allowed.includes(item as T))
  )
    return null;
  return value as T[];
}

const DECISIONS: readonly SkillShadowDecisionCategory[] = [
  "ASK_FOR_INPUT",
  "READY_FOR_PLAN",
  "REQUEST_CONFIRMATION",
  "EXECUTING_TOOL",
  "COMPLETED",
  "NOT_APPLICABLE",
  "UNKNOWN"
];
const REASONS: readonly SkillShadowDisagreementReason[] = [
  "EXISTING_READY_SHADOW_MISSING_ORIGIN",
  "EXISTING_READY_SHADOW_MISSING_DESTINATION",
  "EXISTING_READY_SHADOW_MISSING_DEPARTURE_DATE",
  "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR",
  "EXISTING_READY_SHADOW_MISSING_TRAVELLERS",
  "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION",
  "EXISTING_READY_SHADOW_MISSING_DURATION",
  "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVEL_YEAR",
  "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVELLER_COMPOSITION",
  "EXISTING_ASKING_SHADOW_READY",
  "DIFFERENT_MISSING_FIELD",
  "ADAPTER_INCOMPLETE",
  "SHADOW_EVALUATION_FAILED",
  "SKILL_PERSISTENCE_FAILED",
  "SKILL_REVISION_CONFLICT",
  "DECISION_UNMAPPABLE"
];
const WARNINGS: readonly PlanTripAdapterWarning[] = [
  "NO_CANONICAL_TRIP_FIELDS",
  "UNPARSED_DEPARTURE_DATE",
  "DETERMINISTIC_TRANSCRIPT_DERIVED"
];
const FIELDS: readonly (keyof PlanTripFieldCompleteness)[] = [
  "origin",
  "destination",
  "departureDay",
  "departureMonth",
  "departureYear",
  "travellers",
  "durationOrReturnDate"
];
const PENDING_INPUTS = [
  "ORIGIN",
  "DESTINATION",
  "DEPARTURE_DATE",
  "TRAVEL_YEAR",
  "TRAVELLERS",
  "TRAVELLER_COMPOSITION",
  "DURATION"
] as const;
const CAPABILITIES: readonly (keyof PlanTripReadinessCapabilities)[] = [
  "itinerary",
  "estimate",
  "liveSearch",
  "booking"
];
