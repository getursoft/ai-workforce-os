import { Injectable } from "@nestjs/common";
import type { TravelEntities, TravelPendingInputAction } from "../../travel/travel.runtime";
import type {
  SkillContext,
  SkillDefinition,
  SkillEvaluation,
  SkillHandler,
  SkillInput,
  SkillLifecycleStatus,
  SkillState,
  SkillValidationResult,
  SkillValueSource,
  SkillVersion
} from "../skill-runtime.contracts";

export const PLAN_TRIP_SKILL_ID = "travel.plan-trip";
export const PLAN_TRIP_SKILL_VERSION = "1.0.0";
export const PLAN_TRIP_SCHEMA_VERSION = 1;
export const PLAN_TRIP_POLICY_VERSION = "1.0.0";

export interface PlanTripReadinessCapabilities {
  readonly [capability: string]: boolean;
  itinerary: boolean;
  estimate: boolean;
  liveSearch: boolean;
  booking: boolean;
}

export type PlanTripPolicyBlocker =
  | "MISSING_ORIGIN"
  | "MISSING_DESTINATION"
  | "MISSING_DEPARTURE_DATE"
  | "MISSING_TRAVEL_YEAR"
  | "MISSING_TRAVELLERS"
  | "MISSING_TRAVELLER_COMPOSITION"
  | "MISSING_DURATION_OR_RETURN_DATE";

export type PlanTripPolicyWarning =
  | "PARTIAL_DEPARTURE_DATE"
  | "TOTAL_ONLY_TRAVELLERS"
  | "PURPOSE_NOT_SUPPLIED"
  | "BUDGET_NOT_SUPPLIED";

export interface PlanTripDate {
  value: string | null;
  day: number | null;
  month: number | null;
  year: number | null;
}

export interface PlanTripDuration {
  value: number;
  unit: "DAYS" | "NIGHTS";
}

export interface PlanTripTravellers {
  total: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
}

export interface PlanTripBudget {
  amount: number;
  currency: string | null;
}

export type PlanTripField =
  | "origin"
  | "destination"
  | "departureDate"
  | "returnDate"
  | "duration"
  | "travellers"
  | "budget"
  | "purpose";

export interface PlanTripSkillState extends SkillState {
  origin: string | null;
  destination: string | null;
  departureDate: PlanTripDate | null;
  returnDate: PlanTripDate | null;
  duration: PlanTripDuration | null;
  travellers: PlanTripTravellers;
  budget: PlanTripBudget | null;
  purpose: TravelEntities["tripPurpose"];
  pendingInput:
    | "ORIGIN"
    | "DESTINATION"
    | "DEPARTURE_DATE"
    | "TRAVEL_YEAR"
    | "TRAVELLERS"
    | "TRAVELLER_COMPOSITION"
    | "DURATION"
    | null;
  fieldSources: Partial<Record<PlanTripField, SkillValueSource>>;
}

export interface PlanTripPatchValue<T> {
  value: T;
  source: SkillValueSource;
}

export interface PlanTripSkillInputData {
  origin?: PlanTripPatchValue<string | null>;
  destination?: PlanTripPatchValue<string | null>;
  departureDate?: PlanTripPatchValue<PlanTripDate | null>;
  returnDate?: PlanTripPatchValue<PlanTripDate | null>;
  duration?: PlanTripPatchValue<PlanTripDuration | null>;
  travellers?: PlanTripPatchValue<Partial<PlanTripTravellers>>;
  budget?: PlanTripPatchValue<PlanTripBudget | null>;
  purpose?: PlanTripPatchValue<TravelEntities["tripPurpose"]>;
}

export type PlanTripSkillInput = SkillInput<PlanTripSkillInputData>;

export const PLAN_TRIP_SKILL_DEFINITION: SkillDefinition = {
  id: PLAN_TRIP_SKILL_ID,
  name: "Plan trip",
  description: "Collects and validates the canonical inputs required to plan a trip.",
  activeVersion: PLAN_TRIP_SKILL_VERSION
};

export function emptyPlanTripSkillState(): PlanTripSkillState {
  return {
    schemaVersion: PLAN_TRIP_SCHEMA_VERSION,
    revision: 0,
    lifecycleStatus: "COLLECTING_INPUT",
    origin: null,
    destination: null,
    departureDate: null,
    returnDate: null,
    duration: null,
    travellers: { total: null, adults: null, children: null, infants: null },
    budget: null,
    purpose: null,
    pendingInput: null,
    fieldSources: {}
  };
}

export const PLAN_TRIP_SKILL_VERSION_DEFINITION: SkillVersion<PlanTripSkillState> = {
  skillId: PLAN_TRIP_SKILL_ID,
  version: PLAN_TRIP_SKILL_VERSION,
  schemaVersion: PLAN_TRIP_SCHEMA_VERSION,
  initialState: emptyPlanTripSkillState
};

const SOURCE_STRENGTH: Record<SkillValueSource, number> = {
  MODEL_INFERRED: 1,
  DERIVED: 2,
  EXISTING_RUNTIME: 3,
  USER_EXPLICIT: 4
};

export function mergePlanTripState(
  current: PlanTripSkillState,
  input: PlanTripSkillInput
): PlanTripSkillState {
  const next = structuredClone(current);
  let changed = false;
  const assign = <K extends Exclude<PlanTripField, "travellers">>(
    field: K,
    patch: PlanTripSkillInputData[K]
  ) => {
    if (!patch || patch.value === null || patch.value === undefined) return;
    const priorSource = current.fieldSources[field];
    if (priorSource && SOURCE_STRENGTH[patch.source] < SOURCE_STRENGTH[priorSource]) return;
    if (!deepEqual(next[field], patch.value) || next.fieldSources[field] !== patch.source) {
      (next[field] as typeof patch.value) = patch.value;
      next.fieldSources[field] = patch.source;
      changed = true;
    }
  };

  assign("origin", input.data.origin);
  assign("destination", input.data.destination);
  const mergeDateField = (
    field: "departureDate" | "returnDate",
    patch: PlanTripSkillInputData["departureDate"]
  ) => {
    if (!patch || patch.value === null) return;
    const priorSource = current.fieldSources[field];
    if (priorSource && SOURCE_STRENGTH[patch.source] < SOURCE_STRENGTH[priorSource]) return;
    const value = mergePlanTripDate(next[field], patch.value);
    if (!deepEqual(next[field], value) || priorSource !== patch.source) {
      next[field] = value;
      next.fieldSources[field] = patch.source;
      changed = true;
    }
  };
  mergeDateField("departureDate", input.data.departureDate);
  mergeDateField("returnDate", input.data.returnDate);
  assign("duration", input.data.duration);
  assign("budget", input.data.budget);
  assign("purpose", input.data.purpose);

  const travellerPatch = input.data.travellers;
  if (travellerPatch) {
    const priorSource = current.fieldSources.travellers;
    if (!priorSource || SOURCE_STRENGTH[travellerPatch.source] >= SOURCE_STRENGTH[priorSource]) {
      const merged = mergeTravellers(current.travellers, travellerPatch.value);
      if (!deepEqual(merged, current.travellers) || priorSource !== travellerPatch.source) {
        next.travellers = merged;
        next.fieldSources.travellers = travellerPatch.source;
        changed = true;
      }
    }
  }
  if (changed) next.revision = current.revision + 1;
  return next;
}

export function mergeTravellers(
  current: PlanTripTravellers,
  incoming: Partial<PlanTripTravellers>
): PlanTripTravellers {
  const next = {
    total: incoming.total ?? current.total,
    adults: incoming.adults ?? current.adults,
    children: incoming.children ?? current.children,
    infants: incoming.infants ?? current.infants
  };
  const hasComposition = next.adults !== null || next.children !== null || next.infants !== null;
  if (hasComposition) next.total = (next.adults ?? 0) + (next.children ?? 0) + (next.infants ?? 0);
  return next;
}

export function mergePlanTripDate(
  current: PlanTripDate | null,
  incoming: PlanTripDate
): PlanTripDate {
  if (!current) return incoming;
  const year = incoming.year ?? current.year;
  const month = incoming.month ?? current.month;
  const day = incoming.day ?? current.day;
  const value =
    year !== null && month !== null && day !== null
      ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : (incoming.value ?? current.value);
  return { value, year, month, day };
}

export function validatePlanTripState(state: PlanTripSkillState): SkillValidationResult {
  const errors: SkillValidationResult["errors"] = [];
  if (state.schemaVersion !== PLAN_TRIP_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", code: "UNSUPPORTED_SCHEMA_VERSION" });
  if (state.revision < 0) errors.push({ path: "revision", code: "INVALID_REVISION" });
  if (state.duration && (!Number.isInteger(state.duration.value) || state.duration.value <= 0))
    errors.push({ path: "duration.value", code: "INVALID_DURATION" });
  for (const field of ["total", "adults", "children", "infants"] as const) {
    const value = state.travellers[field];
    if (value !== null && (!Number.isInteger(value) || value < 0))
      errors.push({ path: `travellers.${field}`, code: "INVALID_TRAVELLER_COUNT" });
  }
  return { valid: errors.length === 0, errors };
}

export function nextMissingPlanTripInput(
  state: PlanTripSkillState
): PlanTripSkillState["pendingInput"] {
  if (!state.origin) return "ORIGIN";
  if (!state.destination) return "DESTINATION";
  if (!state.departureDate) return "DEPARTURE_DATE";
  if (state.departureDate && state.departureDate.year === null) return "TRAVEL_YEAR";
  if (!hasTravellerInformation(state.travellers)) return "TRAVELLERS";
  if (!state.duration && !state.returnDate) return "DURATION";
  if (!hasCompleteTravellerComposition(state.travellers)) return "TRAVELLER_COMPOSITION";
  return null;
}

export function planTripReadinessPolicy(state: PlanTripSkillState): {
  policyVersion: typeof PLAN_TRIP_POLICY_VERSION;
  capabilities: PlanTripReadinessCapabilities;
  blockers: PlanTripPolicyBlocker[];
  policyWarnings: PlanTripPolicyWarning[];
} {
  const blockers: PlanTripPolicyBlocker[] = [];
  if (!state.origin) blockers.push("MISSING_ORIGIN");
  if (!state.destination) blockers.push("MISSING_DESTINATION");
  if (!state.departureDate) blockers.push("MISSING_DEPARTURE_DATE");
  else if (state.departureDate.year === null) blockers.push("MISSING_TRAVEL_YEAR");
  if (!hasTravellerInformation(state.travellers)) blockers.push("MISSING_TRAVELLERS");
  else if (!hasCompleteTravellerComposition(state.travellers))
    blockers.push("MISSING_TRAVELLER_COMPOSITION");
  if (!state.duration && !state.returnDate) blockers.push("MISSING_DURATION_OR_RETURN_DATE");

  const earlyPlanningReady = !blockers.some((blocker) =>
    [
      "MISSING_ORIGIN",
      "MISSING_DESTINATION",
      "MISSING_DEPARTURE_DATE",
      "MISSING_TRAVELLERS",
      "MISSING_DURATION_OR_RETURN_DATE"
    ].includes(blocker)
  );
  const liveSearch =
    earlyPlanningReady &&
    !blockers.includes("MISSING_TRAVEL_YEAR") &&
    !blockers.includes("MISSING_TRAVELLER_COMPOSITION");
  const policyWarnings: PlanTripPolicyWarning[] = [];
  if (state.departureDate && state.departureDate.year === null)
    policyWarnings.push("PARTIAL_DEPARTURE_DATE");
  if (
    hasTravellerInformation(state.travellers) &&
    !hasCompleteTravellerComposition(state.travellers)
  )
    policyWarnings.push("TOTAL_ONLY_TRAVELLERS");
  if (state.purpose === null) policyWarnings.push("PURPOSE_NOT_SUPPLIED");
  if (state.budget === null) policyWarnings.push("BUDGET_NOT_SUPPLIED");
  return {
    policyVersion: PLAN_TRIP_POLICY_VERSION,
    capabilities: {
      itinerary: earlyPlanningReady,
      estimate: earlyPlanningReady,
      liveSearch,
      booking: liveSearch
    },
    blockers,
    policyWarnings
  };
}

export function decidePlanTripTurn(
  current: PlanTripSkillState,
  input: PlanTripSkillInput
): SkillEvaluation<PlanTripSkillState> {
  const merged = mergePlanTripState(current, input);
  const validation = validatePlanTripState(merged);
  const policy = planTripReadinessPolicy(merged);
  const missingInput = validation.valid ? nextMissingPlanTripInput(merged) : null;
  const lifecycleStatus: SkillLifecycleStatus =
    validation.valid && policy.capabilities.liveSearch ? "READY" : "COLLECTING_INPUT";
  const state = { ...merged, lifecycleStatus, pendingInput: missingInput };
  return {
    validation,
    decision: {
      skillId: PLAN_TRIP_SKILL_ID,
      skillVersion: PLAN_TRIP_SKILL_VERSION,
      action: lifecycleStatus === "READY" ? "READY" : "ASK_FOR_INPUT",
      missingInput,
      capabilities: policy.capabilities,
      blockers: policy.blockers,
      policyWarnings: policy.policyWarnings,
      state
    },
    transition: {
      previousRevision: current.revision,
      nextRevision: state.revision,
      previousStatus: current.lifecycleStatus,
      nextStatus: lifecycleStatus,
      state
    }
  };
}

export function planTripInputFromTravelEntities(entities: TravelEntities): PlanTripSkillInput {
  const source = "EXISTING_RUNTIME" as const;
  return {
    data: {
      ...(entities.originCity ? { origin: { value: entities.originCity, source } } : {}),
      ...(entities.destinationCity
        ? { destination: { value: entities.destinationCity, source } }
        : {}),
      ...(entities.departureDate || entities.travelMonth
        ? {
            departureDate: {
              value: toPlanTripDate(entities.departureDate, entities.travelMonth),
              source
            }
          }
        : {}),
      ...(entities.returnDate
        ? { returnDate: { value: toPlanTripDate(entities.returnDate, null), source } }
        : {}),
      ...(entities.nights !== null
        ? { duration: { value: { value: entities.nights, unit: "NIGHTS" as const }, source } }
        : entities.days !== null
          ? { duration: { value: { value: entities.days, unit: "DAYS" as const }, source } }
          : {}),
      ...(hasTravelEntityTravellerInformation(entities)
        ? {
            travellers: {
              value: {
                total: entities.totalTravellers,
                adults: entities.adults,
                children: entities.children,
                infants: entities.infants
              },
              source
            }
          }
        : {}),
      ...(entities.budget !== null
        ? {
            budget: {
              value: { amount: entities.budget, currency: entities.budgetCurrency },
              source
            }
          }
        : {}),
      ...(entities.tripPurpose ? { purpose: { value: entities.tripPurpose, source } } : {})
    }
  };
}

export function pendingInputFromTravelAction(
  action: TravelPendingInputAction
): PlanTripSkillState["pendingInput"] {
  if (action === "AWAITING_PASSENGER_COMPOSITION") return "TRAVELLER_COMPOSITION";
  if (action === "AWAITING_TRAVEL_YEAR") return "TRAVEL_YEAR";
  return null;
}

@Injectable()
export class PlanTripSkillHandler implements SkillHandler<PlanTripSkillState, PlanTripSkillInput> {
  readonly definition = PLAN_TRIP_SKILL_DEFINITION;
  readonly version = PLAN_TRIP_SKILL_VERSION_DEFINITION;

  evaluate(
    context: SkillContext<PlanTripSkillState>,
    input: PlanTripSkillInput
  ): SkillEvaluation<PlanTripSkillState> {
    return decidePlanTripTurn(context.currentState, input);
  }
}

function hasTravellerInformation(travellers: PlanTripTravellers): boolean {
  return travellers.total !== null || travellers.adults !== null;
}

function hasCompleteTravellerComposition(travellers: PlanTripTravellers): boolean {
  return travellers.adults !== null && travellers.children !== null && travellers.infants !== null;
}

function hasTravelEntityTravellerInformation(entities: TravelEntities): boolean {
  return entities.totalTravellers !== null || entities.adults !== null;
}

function toPlanTripDate(value: string | null, travelMonth: string | null): PlanTripDate {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match)
    return {
      value,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
  const month = travelMonth ? monthNumber(travelMonth) : null;
  return { value: value ?? travelMonth, year: null, month, day: null };
}

function monthNumber(value: string): number | null {
  const index = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ].indexOf(value.toLowerCase());
  return index < 0 ? null : index + 1;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
