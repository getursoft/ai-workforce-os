import type { Prisma } from "@prisma/client";
import {
  PLAN_TRIP_SCHEMA_VERSION,
  emptyPlanTripSkillState,
  mergePlanTripState,
  planTripInputFromTravelEntities,
  validatePlanTripState,
  type PlanTripDate,
  type PlanTripDuration,
  type PlanTripSkillState,
  type PlanTripTravellers
} from "./plan-trip.skill";
import type { SkillLifecycleStatus, SkillValueSource } from "../skill-runtime.contracts";
import type { TravelEntities } from "../../travel/travel.runtime";

const LIFECYCLE_STATUSES: readonly SkillLifecycleStatus[] = [
  "COLLECTING_INPUT",
  "READY",
  "COMPLETED",
  "CANCELLED"
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
const VALUE_SOURCES: readonly SkillValueSource[] = [
  "USER_EXPLICIT",
  "DERIVED",
  "MODEL_INFERRED",
  "EXISTING_RUNTIME"
];
const SOURCE_FIELDS = [
  "origin",
  "destination",
  "departureDate",
  "returnDate",
  "duration",
  "travellers",
  "budget",
  "purpose"
] as const;

export class InvalidPlanTripSkillStateError extends Error {
  constructor() {
    super("INVALID_PLAN_TRIP_SKILL_STATE");
  }
}

export class PlanTripSkillExecutionMapper {
  static toJson(state: PlanTripSkillState): Prisma.InputJsonObject {
    this.assertValid(state);
    return structuredClone(state) as unknown as Prisma.InputJsonObject;
  }

  static fromJson(value: Prisma.JsonValue): PlanTripSkillState {
    if (!isRecord(value)) throw new InvalidPlanTripSkillStateError();
    const state: PlanTripSkillState = {
      schemaVersion: integer(value.schemaVersion),
      revision: nonNegativeInteger(value.revision),
      lifecycleStatus: enumValue(value.lifecycleStatus, LIFECYCLE_STATUSES),
      origin: nullableString(value.origin),
      destination: nullableString(value.destination),
      departureDate: nullableDate(value.departureDate),
      returnDate: nullableDate(value.returnDate),
      duration: nullableDuration(value.duration),
      travellers: travellers(value.travellers),
      budget: nullableBudget(value.budget),
      purpose:
        value.purpose === null ? null : enumValue(value.purpose, ["LEISURE", "BUSINESS"] as const),
      pendingInput:
        value.pendingInput === null ? null : enumValue(value.pendingInput, PENDING_INPUTS),
      fieldSources: fieldSources(value.fieldSources)
    };
    this.assertValid(state);
    return state;
  }

  /**
   * Build a PlanTripSkillState from legacy Travel entities (e.g. persisted travel.trip_state).
   * Reuses the same field adapter as the shadow comparison path so both readings of the legacy
   * state agree on what counts as "captured" — a field present in `entities` is never re-asked.
   */
  static fromTravelEntities(entities: TravelEntities): PlanTripSkillState {
    const input = planTripInputFromTravelEntities(entities);
    return mergePlanTripState(emptyPlanTripSkillState(), input);
  }

  private static assertValid(state: PlanTripSkillState): void {
    if (state.schemaVersion !== PLAN_TRIP_SCHEMA_VERSION || !validatePlanTripState(state).valid)
      throw new InvalidPlanTripSkillStateError();
    // The mirror schema deliberately has no place for contact or unbounded user/provider payloads.
    const allowedKeys: Array<keyof PlanTripSkillState> = [
      "schemaVersion",
      "revision",
      "lifecycleStatus",
      "origin",
      "destination",
      "departureDate",
      "returnDate",
      "duration",
      "travellers",
      "budget",
      "purpose",
      "pendingInput",
      "fieldSources"
    ];
    if (Object.keys(state).some((key) => !allowedKeys.includes(key as keyof PlanTripSkillState)))
      throw new InvalidPlanTripSkillStateError();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) throw new InvalidPlanTripSkillStateError();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  const result = integer(value);
  if (result < 0) throw new InvalidPlanTripSkillStateError();
  return result;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  return nonNegativeInteger(value);
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 500) throw new InvalidPlanTripSkillStateError();
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InvalidPlanTripSkillStateError();
  return value as T;
}

function nullableDate(value: unknown): PlanTripDate | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new InvalidPlanTripSkillStateError();
  const result = {
    value: nullableString(value.value),
    day: nullableNonNegativeInteger(value.day),
    month: nullableNonNegativeInteger(value.month),
    year: nullableNonNegativeInteger(value.year)
  };
  if (
    (result.day !== null && (result.day < 1 || result.day > 31)) ||
    (result.month !== null && (result.month < 1 || result.month > 12)) ||
    (result.year !== null && (result.year < 1900 || result.year > 9999))
  )
    throw new InvalidPlanTripSkillStateError();
  return result;
}

function nullableDuration(value: unknown): PlanTripDuration | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new InvalidPlanTripSkillStateError();
  return {
    value: nonNegativeInteger(value.value),
    unit: enumValue(value.unit, ["DAYS", "NIGHTS"])
  };
}

function travellers(value: unknown): PlanTripTravellers {
  if (!isRecord(value)) throw new InvalidPlanTripSkillStateError();
  return {
    total: nullableNonNegativeInteger(value.total),
    adults: nullableNonNegativeInteger(value.adults),
    children: nullableNonNegativeInteger(value.children),
    infants: nullableNonNegativeInteger(value.infants)
  };
}

function nullableBudget(value: unknown): PlanTripSkillState["budget"] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.amount !== "number" || !Number.isFinite(value.amount))
    throw new InvalidPlanTripSkillStateError();
  return { amount: value.amount, currency: nullableString(value.currency) };
}

function fieldSources(value: unknown): PlanTripSkillState["fieldSources"] {
  if (!isRecord(value)) throw new InvalidPlanTripSkillStateError();
  const result: PlanTripSkillState["fieldSources"] = {};
  for (const [key, source] of Object.entries(value)) {
    if (!(SOURCE_FIELDS as readonly string[]).includes(key))
      throw new InvalidPlanTripSkillStateError();
    result[key as keyof PlanTripSkillState["fieldSources"]] = enumValue(source, VALUE_SOURCES);
  }
  return result;
}
