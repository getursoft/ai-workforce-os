import type { RequestIntent } from "../../agents/request-classifier";
import type { TravelEntities, TravelStage, TravelWorkflowPhase } from "../../travel/travel.runtime";
import {
  PLAN_TRIP_SKILL_ID,
  PLAN_TRIP_SKILL_VERSION,
  planTripInputFromTravelEntities,
  type PlanTripReadinessCapabilities,
  type PlanTripSkillInput,
  type PlanTripSkillState
} from "./plan-trip.skill";

export type SkillShadowDecisionCategory =
  | "ASK_FOR_INPUT"
  | "READY_FOR_PLAN"
  | "REQUEST_CONFIRMATION"
  | "EXECUTING_TOOL"
  | "COMPLETED"
  | "NOT_APPLICABLE"
  | "UNKNOWN";

export type PlanTripMissingField = PlanTripSkillState["pendingInput"];

export type SkillShadowDisagreementReason =
  | "EXISTING_READY_SHADOW_MISSING_ORIGIN"
  | "EXISTING_READY_SHADOW_MISSING_DESTINATION"
  | "EXISTING_READY_SHADOW_MISSING_DEPARTURE_DATE"
  | "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR"
  | "EXISTING_READY_SHADOW_MISSING_TRAVELLERS"
  | "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION"
  | "EXISTING_READY_SHADOW_MISSING_DURATION"
  | "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVEL_YEAR"
  | "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVELLER_COMPOSITION"
  | "EXISTING_ASKING_SHADOW_READY"
  | "DIFFERENT_MISSING_FIELD"
  | "ADAPTER_INCOMPLETE"
  | "SHADOW_EVALUATION_FAILED"
  | "SKILL_PERSISTENCE_FAILED"
  | "SKILL_REVISION_CONFLICT"
  | "DECISION_UNMAPPABLE";

export type PlanTripAdapterWarning =
  "NO_CANONICAL_TRIP_FIELDS" | "UNPARSED_DEPARTURE_DATE" | "DETERMINISTIC_TRANSCRIPT_DERIVED";

export interface PlanTripFieldCompleteness {
  origin: boolean;
  destination: boolean;
  departureDay: boolean;
  departureMonth: boolean;
  departureYear: boolean;
  travellers: boolean;
  durationOrReturnDate: boolean;
}

export interface ExistingTravelDecision {
  category: SkillShadowDecisionCategory;
  missingField: PlanTripMissingField;
  ready: boolean | null;
}

export interface PlanTripShadowComparison {
  skillId: typeof PLAN_TRIP_SKILL_ID;
  skillVersion: typeof PLAN_TRIP_SKILL_VERSION;
  mode: "SHADOW";
  existingDecision: SkillShadowDecisionCategory;
  shadowDecision: SkillShadowDecisionCategory;
  agreement: boolean;
  reasonCodes: SkillShadowDisagreementReason[];
  existingMissingField: PlanTripMissingField;
  shadowMissingField: PlanTripMissingField;
  existingReady: boolean | null;
  shadowReady: boolean | null;
  shadowCapabilities: PlanTripReadinessCapabilities;
  capabilityAgreement: boolean | null;
  fieldCompleteness: PlanTripFieldCompleteness;
  adapterWarnings: PlanTripAdapterWarning[];
  persistence?: {
    executionId: string | null;
    status: string | null;
    revision: number | null;
    applied: boolean;
    idempotentReplay: boolean;
    warning: "SKILL_PERSISTENCE_FAILED" | "SKILL_REVISION_CONFLICT" | null;
  };
}

export interface ExistingTravelDecisionInput {
  requestIntent: RequestIntent;
  stage: TravelStage | null;
  workflowPhase: TravelWorkflowPhase | null;
  toolCallsAttempted: number;
  entities: TravelEntities;
}

export interface PlanTripShadowAdapterResult {
  input: PlanTripSkillInput;
  fieldCompleteness: PlanTripFieldCompleteness;
  warnings: PlanTripAdapterWarning[];
}

export interface PlanTripShadowAggregate {
  totalEvaluations: number;
  agreements: number;
  disagreements: number;
  agreementPercentage: number;
  disagreementCounts: Partial<Record<SkillShadowDisagreementReason, number>>;
  decisionPairCounts: Record<string, number>;
}

/**
 * Deterministic Travel exposes a transcript-derived legacy state rather than the LLM orchestrator's
 * final entity object. For shadowing only, retain prior structured values when the legacy derivation
 * cannot represent them. Null incoming values never erase known state.
 */
export function mergeDeterministicTravelShadowEntities(
  persisted: TravelEntities,
  transcriptDerived: TravelEntities
): TravelEntities {
  const merged = { ...persisted };
  for (const key of Object.keys(transcriptDerived) as Array<keyof TravelEntities>) {
    const value = transcriptDerived[key];
    if (key === "preferences") {
      if ((value as string[]).length > 0) merged.preferences = value as string[];
      continue;
    }
    if (value !== null) (merged[key] as typeof value) = value;
  }
  return merged;
}

const APPLICABLE_INTENTS: ReadonlySet<RequestIntent> = new Set([
  "TASK_EXECUTION",
  "TRAVEL_PLANNING",
  "SLOT_UPDATE",
  "CONFIRMATION",
  "CORRECTION"
]);

export function adaptTravelEntitiesForPlanTripShadow(
  entities: TravelEntities,
  options: { deterministicTranscriptDerived?: boolean } = {}
): PlanTripShadowAdapterResult {
  const input = planTripInputFromTravelEntities(entities);
  const departureDate = input.data.departureDate?.value ?? null;
  const completeness: PlanTripFieldCompleteness = {
    origin: Boolean(entities.originCity),
    destination: Boolean(entities.destinationCity),
    departureDay: departureDate?.day !== null && departureDate?.day !== undefined,
    departureMonth: departureDate?.month !== null && departureDate?.month !== undefined,
    departureYear: departureDate?.year !== null && departureDate?.year !== undefined,
    travellers: entities.totalTravellers !== null || entities.adults !== null,
    durationOrReturnDate:
      entities.days !== null || entities.nights !== null || entities.returnDate !== null
  };
  const warnings: PlanTripAdapterWarning[] = [];
  if (options.deterministicTranscriptDerived) warnings.push("DETERMINISTIC_TRANSCRIPT_DERIVED");
  if (
    entities.departureDate &&
    !completeness.departureDay &&
    !completeness.departureMonth &&
    !completeness.departureYear
  )
    warnings.push("UNPARSED_DEPARTURE_DATE");
  if (
    !completeness.origin &&
    !completeness.destination &&
    !completeness.departureMonth &&
    !completeness.travellers &&
    !completeness.durationOrReturnDate
  )
    warnings.push("NO_CANONICAL_TRIP_FIELDS");
  return { input, fieldCompleteness: completeness, warnings };
}

export function normalizeExistingTravelDecision(
  input: ExistingTravelDecisionInput
): ExistingTravelDecision {
  if (!APPLICABLE_INTENTS.has(input.requestIntent))
    return { category: "NOT_APPLICABLE", missingField: null, ready: null };
  if (input.toolCallsAttempted > 0 || input.workflowPhase === "SEARCHING")
    return { category: "EXECUTING_TOOL", missingField: null, ready: true };
  if (input.workflowPhase === "AWAITING_CONFIRMATION" || input.stage === "CONFIRM_BOOKING")
    return { category: "REQUEST_CONFIRMATION", missingField: null, ready: true };
  if (
    input.stage === "BOOKING_CONFIRMED" ||
    input.stage === "ITINERARY_SUMMARY" ||
    input.stage === "ESCALATED" ||
    input.workflowPhase === "OPTIONS_PRESENTED"
  )
    return { category: "COMPLETED", missingField: null, ready: true };
  if (input.workflowPhase === "READY_TO_SEARCH" || input.stage === "RECOMMEND_OPTIONS")
    return { category: "READY_FOR_PLAN", missingField: null, ready: true };

  const missingField = existingMissingField(input.stage, input.entities);
  if (missingField) return { category: "ASK_FOR_INPUT", missingField, ready: false };
  if (isExistingInputStage(input.stage))
    return { category: "ASK_FOR_INPUT", missingField: null, ready: false };
  return { category: "UNKNOWN", missingField: null, ready: null };
}

export function comparePlanTripShadow(input: {
  existing: ExistingTravelDecision;
  shadowAction: "ASK_FOR_INPUT" | "READY";
  shadowMissingField: PlanTripMissingField;
  shadowCapabilities?: Readonly<Record<string, boolean>> | undefined;
  fieldCompleteness: PlanTripFieldCompleteness;
  adapterWarnings: PlanTripAdapterWarning[];
}): PlanTripShadowComparison {
  const shadowCapabilities = normalizeCapabilities(input.shadowCapabilities, input.shadowAction);
  const shadowDecision: SkillShadowDecisionCategory =
    input.existing.category === "NOT_APPLICABLE"
      ? "NOT_APPLICABLE"
      : input.shadowAction === "READY"
        ? "READY_FOR_PLAN"
        : "ASK_FOR_INPUT";
  const shadowReady =
    shadowDecision === "NOT_APPLICABLE" ? null : shadowDecision === "READY_FOR_PLAN";
  const reasonCodes: SkillShadowDisagreementReason[] = [];

  if (input.existing.category === "UNKNOWN") reasonCodes.push("DECISION_UNMAPPABLE");
  if (
    input.existing.category !== "NOT_APPLICABLE" &&
    hasIncompleteAdapterWarning(input.adapterWarnings)
  )
    reasonCodes.push("ADAPTER_INCOMPLETE");
  if (input.existing.ready === true && shadowReady === false && input.shadowMissingField)
    reasonCodes.push(readyMissingReason(input.shadowMissingField));
  if (
    input.existing.category === "EXECUTING_TOOL" &&
    !shadowCapabilities.liveSearch &&
    input.shadowMissingField === "TRAVEL_YEAR"
  )
    replaceReason(
      reasonCodes,
      "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR",
      "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVEL_YEAR"
    );
  if (
    input.existing.category === "EXECUTING_TOOL" &&
    !shadowCapabilities.liveSearch &&
    input.shadowMissingField === "TRAVELLER_COMPOSITION"
  )
    replaceReason(
      reasonCodes,
      "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION",
      "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVELLER_COMPOSITION"
    );
  if (input.existing.category === "ASK_FOR_INPUT" && shadowReady === true)
    reasonCodes.push("EXISTING_ASKING_SHADOW_READY");
  if (
    input.existing.category === "ASK_FOR_INPUT" &&
    shadowDecision === "ASK_FOR_INPUT" &&
    input.existing.missingField !== null &&
    input.shadowMissingField !== null &&
    input.existing.missingField !== input.shadowMissingField
  )
    reasonCodes.push("DIFFERENT_MISSING_FIELD");

  const capabilityAgreement = existingCapabilityAgreement(
    input.existing.category,
    shadowCapabilities
  );
  const agreement =
    input.existing.category === "NOT_APPLICABLE" ||
    (reasonCodes.length === 0 && (capabilityAgreement ?? input.existing.ready === shadowReady));
  return {
    skillId: PLAN_TRIP_SKILL_ID,
    skillVersion: PLAN_TRIP_SKILL_VERSION,
    mode: "SHADOW",
    existingDecision: input.existing.category,
    shadowDecision,
    agreement,
    reasonCodes,
    existingMissingField: input.existing.missingField,
    shadowMissingField: shadowDecision === "NOT_APPLICABLE" ? null : input.shadowMissingField,
    existingReady: input.existing.ready,
    shadowReady,
    shadowCapabilities,
    capabilityAgreement,
    fieldCompleteness: input.fieldCompleteness,
    adapterWarnings: input.adapterWarnings
  };
}

export function failedPlanTripShadowComparison(input: {
  existing: ExistingTravelDecision;
  fieldCompleteness: PlanTripFieldCompleteness;
  adapterWarnings: PlanTripAdapterWarning[];
}): PlanTripShadowComparison {
  return {
    skillId: PLAN_TRIP_SKILL_ID,
    skillVersion: PLAN_TRIP_SKILL_VERSION,
    mode: "SHADOW",
    existingDecision: input.existing.category,
    shadowDecision: "UNKNOWN",
    agreement: false,
    reasonCodes: ["SHADOW_EVALUATION_FAILED"],
    existingMissingField: input.existing.missingField,
    shadowMissingField: null,
    existingReady: input.existing.ready,
    shadowReady: null,
    shadowCapabilities: emptyCapabilities(),
    capabilityAgreement: false,
    fieldCompleteness: input.fieldCompleteness,
    adapterWarnings: input.adapterWarnings
  };
}

export function withPlanTripShadowPersistence(
  comparison: PlanTripShadowComparison,
  persistence: NonNullable<PlanTripShadowComparison["persistence"]>
): PlanTripShadowComparison {
  const reasonCodes = [...comparison.reasonCodes];
  if (persistence.warning && !reasonCodes.includes(persistence.warning))
    reasonCodes.push(persistence.warning);
  return {
    ...comparison,
    agreement: persistence.warning ? false : comparison.agreement,
    reasonCodes,
    persistence
  };
}

export function aggregatePlanTripShadowComparisons(
  comparisons: readonly PlanTripShadowComparison[]
): PlanTripShadowAggregate {
  const result: PlanTripShadowAggregate = {
    totalEvaluations: comparisons.length,
    agreements: 0,
    disagreements: 0,
    agreementPercentage: 0,
    disagreementCounts: {},
    decisionPairCounts: {}
  };
  for (const comparison of comparisons) {
    if (comparison.agreement) result.agreements += 1;
    else result.disagreements += 1;
    for (const reason of comparison.reasonCodes)
      result.disagreementCounts[reason] = (result.disagreementCounts[reason] ?? 0) + 1;
    const pair = `${comparison.existingDecision}->${comparison.shadowDecision}`;
    result.decisionPairCounts[pair] = (result.decisionPairCounts[pair] ?? 0) + 1;
  }
  result.agreementPercentage = comparisons.length
    ? Number(((result.agreements / comparisons.length) * 100).toFixed(2))
    : 0;
  return result;
}

function existingMissingField(
  stage: TravelStage | null,
  entities: TravelEntities
): PlanTripMissingField {
  if (stage === "COLLECT_DESTINATION") return "DESTINATION";
  if (stage === "ASK_TRAVEL_YEAR") return "TRAVEL_YEAR";
  if (stage === "COLLECT_PASSENGERS") return "TRAVELLERS";
  if (stage === "COLLECT_DATES")
    return !entities.departureDate && !entities.travelMonth ? "DEPARTURE_DATE" : "DURATION";
  if (stage === "ASK_MISSING_INFO") {
    if (!entities.originCity) return "ORIGIN";
    if (!entities.destinationCity) return "DESTINATION";
    if (!entities.departureDate && !entities.travelMonth) return "DEPARTURE_DATE";
    if (entities.adults === null && entities.totalTravellers === null) return "TRAVELLERS";
    if (entities.days === null && entities.nights === null && !entities.returnDate)
      return "DURATION";
  }
  return null;
}

function isExistingInputStage(stage: TravelStage | null): boolean {
  return (
    stage === "GREETING" ||
    stage === "COLLECT_NAME" ||
    stage === "DISCOVER_INTENT" ||
    stage === "COLLECT_DESTINATION" ||
    stage === "COLLECT_DATES" ||
    stage === "ASK_TRAVEL_YEAR" ||
    stage === "COLLECT_PASSENGERS" ||
    stage === "COLLECT_BUDGET" ||
    stage === "ASK_MISSING_INFO" ||
    stage === "AWAITING_CONTACT"
  );
}

function readyMissingReason(
  field: Exclude<PlanTripMissingField, null>
): SkillShadowDisagreementReason {
  const reasons: Record<Exclude<PlanTripMissingField, null>, SkillShadowDisagreementReason> = {
    ORIGIN: "EXISTING_READY_SHADOW_MISSING_ORIGIN",
    DESTINATION: "EXISTING_READY_SHADOW_MISSING_DESTINATION",
    DEPARTURE_DATE: "EXISTING_READY_SHADOW_MISSING_DEPARTURE_DATE",
    TRAVEL_YEAR: "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR",
    TRAVELLERS: "EXISTING_READY_SHADOW_MISSING_TRAVELLERS",
    TRAVELLER_COMPOSITION: "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION",
    DURATION: "EXISTING_READY_SHADOW_MISSING_DURATION"
  };
  return reasons[field];
}

function normalizeCapabilities(
  value: Readonly<Record<string, boolean>> | undefined,
  action: "ASK_FOR_INPUT" | "READY"
): PlanTripReadinessCapabilities {
  if (!value)
    return {
      itinerary: action === "READY",
      estimate: action === "READY",
      liveSearch: action === "READY",
      booking: action === "READY"
    };
  return {
    itinerary: value.itinerary === true,
    estimate: value.estimate === true,
    liveSearch: value.liveSearch === true,
    booking: value.booking === true
  };
}

function emptyCapabilities(): PlanTripReadinessCapabilities {
  return { itinerary: false, estimate: false, liveSearch: false, booking: false };
}

function existingCapabilityAgreement(
  category: SkillShadowDecisionCategory,
  capabilities: PlanTripReadinessCapabilities
): boolean | null {
  if (category === "READY_FOR_PLAN") return capabilities.itinerary;
  if (category === "EXECUTING_TOOL") return capabilities.liveSearch;
  if (category === "REQUEST_CONFIRMATION") return capabilities.booking;
  if (category === "NOT_APPLICABLE" || category === "UNKNOWN") return null;
  return null;
}

function replaceReason(
  reasons: SkillShadowDisagreementReason[],
  from: SkillShadowDisagreementReason,
  to: SkillShadowDisagreementReason
): void {
  const index = reasons.indexOf(from);
  if (index >= 0) reasons[index] = to;
  else if (!reasons.includes(to)) reasons.push(to);
}

function hasIncompleteAdapterWarning(warnings: readonly PlanTripAdapterWarning[]): boolean {
  return (
    warnings.includes("NO_CANONICAL_TRIP_FIELDS") || warnings.includes("UNPARSED_DEPARTURE_DATE")
  );
}
