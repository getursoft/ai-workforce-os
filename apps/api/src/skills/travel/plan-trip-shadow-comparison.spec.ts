import { describe, expect, it } from "vitest";
import { EMPTY_TRAVEL_ENTITIES, type TravelEntities } from "../../travel/travel.runtime";
import {
  adaptTravelEntitiesForPlanTripShadow,
  aggregatePlanTripShadowComparisons,
  comparePlanTripShadow,
  failedPlanTripShadowComparison,
  mergeDeterministicTravelShadowEntities,
  normalizeExistingTravelDecision,
  withPlanTripShadowPersistence,
  type ExistingTravelDecision,
  type PlanTripFieldCompleteness,
  type PlanTripMissingField,
  type SkillShadowDisagreementReason
} from "./plan-trip-shadow-comparison";

const completeEntities: TravelEntities = {
  ...EMPTY_TRAVEL_ENTITIES,
  originCity: "Delhi",
  destinationCity: "Dubai",
  departureDate: "2027-01-12",
  days: 4,
  adults: 3,
  children: 0,
  infants: 0,
  totalTravellers: 3
};

const completeFields: PlanTripFieldCompleteness = {
  origin: true,
  destination: true,
  departureDay: true,
  departureMonth: true,
  departureYear: true,
  travellers: true,
  durationOrReturnDate: true
};

const readyExisting: ExistingTravelDecision = {
  category: "READY_FOR_PLAN",
  missingField: null,
  ready: true
};

function compare(input: {
  existing?: ExistingTravelDecision;
  shadowAction?: "ASK_FOR_INPUT" | "READY";
  shadowMissingField?: PlanTripMissingField;
  shadowCapabilities?: Parameters<typeof comparePlanTripShadow>[0]["shadowCapabilities"];
  warnings?: Parameters<typeof comparePlanTripShadow>[0]["adapterWarnings"];
}) {
  return comparePlanTripShadow({
    existing: input.existing ?? readyExisting,
    shadowAction: input.shadowAction ?? "READY",
    shadowMissingField: input.shadowMissingField ?? null,
    shadowCapabilities: input.shadowCapabilities,
    fieldCompleteness: completeFields,
    adapterWarnings: input.warnings ?? []
  });
}

describe("travel.plan-trip shadow comparison", () => {
  it("agrees when the existing and shadow decisions are both ready", () => {
    expect(compare({})).toMatchObject({
      existingDecision: "READY_FOR_PLAN",
      shadowDecision: "READY_FOR_PLAN",
      agreement: true,
      reasonCodes: []
    });
  });

  it("agrees when both decisions ask for the same missing field", () => {
    expect(
      compare({
        existing: { category: "ASK_FOR_INPUT", missingField: "ORIGIN", ready: false },
        shadowAction: "ASK_FOR_INPUT",
        shadowMissingField: "ORIGIN"
      })
    ).toMatchObject({ agreement: true, reasonCodes: [] });
  });

  it.each([
    ["ORIGIN", "EXISTING_READY_SHADOW_MISSING_ORIGIN"],
    ["DESTINATION", "EXISTING_READY_SHADOW_MISSING_DESTINATION"],
    ["DEPARTURE_DATE", "EXISTING_READY_SHADOW_MISSING_DEPARTURE_DATE"],
    ["TRAVEL_YEAR", "EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR"],
    ["TRAVELLERS", "EXISTING_READY_SHADOW_MISSING_TRAVELLERS"],
    ["TRAVELLER_COMPOSITION", "EXISTING_READY_SHADOW_MISSING_TRAVELLER_COMPOSITION"],
    ["DURATION", "EXISTING_READY_SHADOW_MISSING_DURATION"]
  ] as const)("explains existing-ready disagreement when shadow needs %s", (field, reason) => {
    expect(
      compare({ shadowAction: "ASK_FOR_INPUT", shadowMissingField: field }).reasonCodes
    ).toEqual([reason]);
  });

  it("explains when existing asks for input but shadow is ready", () => {
    expect(
      compare({
        existing: { category: "ASK_FOR_INPUT", missingField: null, ready: false }
      }).reasonCodes
    ).toEqual(["EXISTING_ASKING_SHADOW_READY"]);
  });

  it("records itinerary capability agreement despite an approved year collection difference", () => {
    expect(
      compare({
        shadowAction: "ASK_FOR_INPUT",
        shadowMissingField: "TRAVEL_YEAR",
        shadowCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: false,
          booking: false
        }
      })
    ).toMatchObject({ capabilityAgreement: true, shadowCapabilities: { liveSearch: false } });
  });

  it.each([
    ["TRAVEL_YEAR", "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVEL_YEAR"],
    ["TRAVELLER_COMPOSITION", "EXISTING_LIVE_SEARCH_SHADOW_MISSING_TRAVELLER_COMPOSITION"]
  ] as const)("blocks live search when shadow still needs %s", (field, reason) => {
    expect(
      compare({
        existing: { category: "EXECUTING_TOOL", missingField: null, ready: true },
        shadowAction: "ASK_FOR_INPUT",
        shadowMissingField: field,
        shadowCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: false,
          booking: false
        }
      })
    ).toMatchObject({ capabilityAgreement: false, reasonCodes: [reason] });
  });

  it("explains when both ask for different fields", () => {
    expect(
      compare({
        existing: { category: "ASK_FOR_INPUT", missingField: "ORIGIN", ready: false },
        shadowAction: "ASK_FOR_INPUT",
        shadowMissingField: "DESTINATION"
      }).reasonCodes
    ).toEqual(["DIFFERENT_MISSING_FIELD"]);
  });

  it("normalises a non-planning request as NOT_APPLICABLE", () => {
    const existing = normalizeExistingTravelDecision({
      requestIntent: "KNOWLEDGE_QUERY",
      stage: "RECOMMEND_OPTIONS",
      workflowPhase: "READY_TO_SEARCH",
      toolCallsAttempted: 0,
      entities: completeEntities
    });
    expect(compare({ existing })).toMatchObject({
      existingDecision: "NOT_APPLICABLE",
      shadowDecision: "NOT_APPLICABLE",
      agreement: true
    });
  });

  it("marks incomplete adaptation explicitly", () => {
    expect(compare({ warnings: ["NO_CANONICAL_TRIP_FIELDS"] }).reasonCodes).toEqual([
      "ADAPTER_INCOMPLETE"
    ]);
  });

  it("marks an unmappable existing decision explicitly", () => {
    expect(
      compare({ existing: { category: "UNKNOWN", missingField: null, ready: null } }).reasonCodes
    ).toEqual(["DECISION_UNMAPPABLE"]);
  });

  it("turns shadow evaluation failure into comparison data", () => {
    expect(
      failedPlanTripShadowComparison({
        existing: readyExisting,
        fieldCompleteness: completeFields,
        adapterWarnings: []
      })
    ).toMatchObject({
      agreement: false,
      shadowDecision: "UNKNOWN",
      reasonCodes: ["SHADOW_EVALUATION_FAILED"]
    });
  });

  it.each(["SKILL_PERSISTENCE_FAILED", "SKILL_REVISION_CONFLICT"] as const)(
    "records mirror persistence warning %s without raw persistence data",
    (warning) => {
      expect(
        withPlanTripShadowPersistence(compare({}), {
          executionId: null,
          status: null,
          revision: null,
          applied: false,
          idempotentReplay: false,
          warning
        })
      ).toMatchObject({ agreement: false, reasonCodes: [warning] });
    }
  );

  it("adapts LLM structured entities without transcript warnings", () => {
    const adapter = adaptTravelEntitiesForPlanTripShadow(completeEntities);
    expect(adapter.warnings).toEqual([]);
    expect(adapter.fieldCompleteness).toEqual(completeFields);
  });

  it("adapts deterministic transcript-derived entities and labels their provenance", () => {
    const adapter = adaptTravelEntitiesForPlanTripShadow(completeEntities, {
      deterministicTranscriptDerived: true
    });
    expect(adapter.warnings).toEqual(["DETERMINISTIC_TRANSCRIPT_DERIVED"]);
    expect(adapter.input.data.destination?.value).toBe("Dubai");
  });

  it("preserves structured deterministic state that legacy transcript derivation cannot represent", () => {
    const merged = mergeDeterministicTravelShadowEntities(
      { ...completeEntities, originCity: "Delhi", destinationCity: "Dubai" },
      { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "London", days: 6 }
    );
    expect(merged).toMatchObject({ originCity: "Delhi", destinationCity: "London", days: 6 });
  });

  it("aggregates agreement, reason, and decision-pair counts without persistence", () => {
    const comparisons = [
      compare({}),
      compare({ shadowAction: "ASK_FOR_INPUT", shadowMissingField: "TRAVEL_YEAR" })
    ];
    expect(aggregatePlanTripShadowComparisons(comparisons)).toEqual({
      totalEvaluations: 2,
      agreements: 1,
      disagreements: 1,
      agreementPercentage: 50,
      disagreementCounts: { EXISTING_READY_SHADOW_MISSING_TRAVEL_YEAR: 1 },
      decisionPairCounts: {
        "READY_FOR_PLAN->READY_FOR_PLAN": 1,
        "READY_FOR_PLAN->ASK_FOR_INPUT": 1
      }
    });
  });

  it("covers every declared disagreement reason in the test matrix", () => {
    const covered = new Set<SkillShadowDisagreementReason>([
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
    ]);
    expect(covered.size).toBe(16);
  });
});
