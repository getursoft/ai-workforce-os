import { describe, expect, it } from "vitest";
import {
  decidePlanTripTurn,
  emptyPlanTripSkillState,
  mergePlanTripState,
  planTripReadinessPolicy,
  type PlanTripSkillInput,
  type PlanTripSkillState
} from "./plan-trip.skill";

const explicit = <T>(value: T) => ({ value, source: "USER_EXPLICIT" as const });

function state(overrides: Partial<PlanTripSkillState> = {}): PlanTripSkillState {
  return {
    ...mergePlanTripState(emptyPlanTripSkillState(), {
      data: {
        origin: explicit("Delhi"),
        destination: explicit("Dubai"),
        departureDate: explicit({ value: "2027-01-12", day: 12, month: 1, year: 2027 }),
        duration: explicit({ value: 4, unit: "NIGHTS" }),
        travellers: explicit({ adults: 3, children: 1, infants: 0 })
      }
    }),
    ...overrides
  };
}

function decide(current: PlanTripSkillState, data: PlanTripSkillInput["data"] = {}) {
  return decidePlanTripTurn(current, { data }).decision;
}

describe("travel.plan-trip approved product policy v1.0.0", () => {
  it.each([
    { value: "January", day: null, month: 1, year: null },
    { value: "12 January", day: 12, month: 1, year: null }
  ])("stores a partial date but asks for year before live search", (departureDate) => {
    const result = decide(state({ departureDate }));
    expect(result).toMatchObject({
      action: "ASK_FOR_INPUT",
      missingInput: "TRAVEL_YEAR",
      capabilities: { itinerary: true, estimate: true, liveSearch: false, booking: false }
    });
  });

  it("completes a partial date from a standalone year without changing other fields", () => {
    const current = state({
      departureDate: { value: "12 January", day: 12, month: 1, year: null }
    });
    const result = decide(current, {
      departureDate: explicit({ value: "2027", day: null, month: null, year: 2027 })
    });
    expect(result.state).toMatchObject({
      origin: "Delhi",
      destination: "Dubai",
      departureDate: { value: "2027-01-12", day: 12, month: 1, year: 2027 },
      duration: { value: 4, unit: "NIGHTS" },
      travellers: { total: 4, adults: 3, children: 1, infants: 0 }
    });
  });

  it("allows total-only travellers for itinerary and broad estimate but not live search or booking", () => {
    const result = decide(
      state({ travellers: { total: 5, adults: null, children: null, infants: null } })
    );
    expect(result).toMatchObject({
      missingInput: "TRAVELLER_COMPOSITION",
      capabilities: { itinerary: true, estimate: true, liveSearch: false, booking: false },
      policyWarnings: expect.arrayContaining(["TOTAL_ONLY_TRAVELLERS"])
    });
    expect(result.state.travellers).toEqual({
      total: 5,
      adults: null,
      children: null,
      infants: null
    });
  });

  it("enables passenger-sensitive readiness only after explicit composition", () => {
    expect(decide(state()).capabilities).toEqual({
      itinerary: true,
      estimate: true,
      liveSearch: true,
      booking: true
    });
  });

  it.each(["purpose", "budget"] as const)("does not block when optional %s is missing", (field) => {
    const current = state();
    current[field] = null;
    expect(planTripReadinessPolicy(current).capabilities.liveSearch).toBe(true);
  });

  it("accepts either duration or return date", () => {
    expect(
      decide(
        state({
          duration: null,
          returnDate: { value: "2027-01-16", day: 16, month: 1, year: 2027 }
        })
      ).capabilities?.liveSearch
    ).toBe(true);
    expect(decide(state({ returnDate: null })).capabilities?.liveSearch).toBe(true);
    expect(decide(state({ duration: null, returnDate: null }))).toMatchObject({
      action: "ASK_FOR_INPUT",
      missingInput: "DURATION",
      capabilities: { itinerary: false, estimate: false, liveSearch: false, booking: false }
    });
  });

  it("preserves four nights canonically instead of deriving days", () => {
    expect(decide(state()).state.duration).toEqual({ value: 4, unit: "NIGHTS" });
  });

  it("keeps confirmation outside the shadow policy decision", () => {
    expect(decide(state({ destination: null }))).toMatchObject({
      action: "ASK_FOR_INPUT",
      missingInput: "DESTINATION"
    });
    expect(Object.keys(decide(state()))).not.toContain("confirmation");
  });
});
