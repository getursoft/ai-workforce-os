import { describe, expect, it } from "vitest";
import {
  decidePlanTripTurn,
  emptyPlanTripSkillState,
  mergePlanTripState,
  planTripInputFromTravelEntities,
  type PlanTripSkillInput,
  type PlanTripSkillState
} from "./plan-trip.skill";
import { EMPTY_TRAVEL_ENTITIES } from "../../travel/travel.runtime";

const explicit = <T>(value: T) => ({ value, source: "USER_EXPLICIT" as const });

function completeState(): PlanTripSkillState {
  return mergePlanTripState(emptyPlanTripSkillState(), {
    data: {
      origin: explicit("Delhi"),
      destination: explicit("Dubai"),
      departureDate: explicit({ value: "2027-01-12", day: 12, month: 1, year: 2027 }),
      duration: explicit({ value: 4, unit: "DAYS" }),
      travellers: explicit({ adults: 3, children: 0, infants: 0 })
    }
  });
}

function decide(state: PlanTripSkillState, data: PlanTripSkillInput["data"] = {}) {
  return decidePlanTripTurn(state, { data }).decision;
}

describe("travel.plan-trip v1", () => {
  it("marks a complete plan READY", () => {
    expect(decide(completeState())).toMatchObject({ action: "READY", missingInput: null });
  });

  it.each([
    ["origin", "ORIGIN"],
    ["destination", "DESTINATION"],
    ["departureDate", "DEPARTURE_DATE"],
    ["travellers", "TRAVELLERS"],
    ["duration", "DURATION"]
  ] as const)("asks for missing %s", (field, expected) => {
    const state = completeState();
    if (field === "travellers")
      state.travellers = { total: null, adults: null, children: null, infants: null };
    else state[field] = null;
    expect(decide(state)).toMatchObject({ action: "ASK_FOR_INPUT", missingInput: expected });
  });

  it("preserves a partial departure date and asks for its year", () => {
    const state = completeState();
    state.departureDate = { value: "12 January", day: 12, month: 1, year: null };
    const result = decide(state);
    expect(result.missingInput).toBe("TRAVEL_YEAR");
    expect(result.state.departureDate).toEqual({
      value: "12 January",
      day: 12,
      month: 1,
      year: null
    });
  });

  it("allows return date to satisfy the duration requirement", () => {
    const state = completeState();
    state.duration = null;
    state.returnDate = { value: "2027-01-16", day: 16, month: 1, year: 2027 };
    expect(decide(state).action).toBe("READY");
  });

  it("merges a year-only update without erasing other known fields", () => {
    const state = completeState();
    state.departureDate = { value: "12 January", day: 12, month: 1, year: null };
    const result = decide(state, {
      departureDate: explicit({ value: "2027", day: null, month: null, year: 2027 })
    });
    expect(result.state).toMatchObject({
      origin: "Delhi",
      destination: "Dubai",
      duration: { value: 4, unit: "DAYS" },
      travellers: { total: 3, adults: 3 },
      departureDate: { value: "2027-01-12", day: 12, month: 1, year: 2027 }
    });
  });

  it("applies a destination correction without altering other fields", () => {
    const result = decide(completeState(), { destination: explicit("London") });
    expect(result.state).toMatchObject({
      origin: "Delhi",
      destination: "London",
      duration: { value: 4, unit: "DAYS" },
      travellers: { total: 3, adults: 3 }
    });
  });

  it("recalculates traveller total after a composition correction", () => {
    const state = completeState();
    state.travellers = { total: 4, adults: 3, children: 1, infants: 0 };
    const result = decide(state, { travellers: explicit({ adults: 2 }) });
    expect(result.state.travellers).toEqual({ total: 3, adults: 2, children: 1, infants: 0 });
  });

  it("does not convert five unspecified travellers into five adults", () => {
    const input = planTripInputFromTravelEntities({
      ...EMPTY_TRAVEL_ENTITIES,
      totalTravellers: 5
    });
    const state = decidePlanTripTurn(emptyPlanTripSkillState(), input).decision.state;
    expect(state.travellers).toEqual({ total: 5, adults: null, children: null, infants: null });
  });

  it("preserves four nights as NIGHTS", () => {
    const input = planTripInputFromTravelEntities({ ...EMPTY_TRAVEL_ENTITIES, nights: 4 });
    expect(decidePlanTripTurn(emptyPlanTripSkillState(), input).decision.state.duration).toEqual({
      value: 4,
      unit: "NIGHTS"
    });
  });

  it("never lets missing incoming values erase existing state", () => {
    const result = decide(completeState(), {
      origin: explicit(null),
      destination: explicit(null),
      duration: explicit(null)
    });
    expect(result.state).toMatchObject({
      origin: "Delhi",
      destination: "Dubai",
      duration: { value: 4, unit: "DAYS" }
    });
  });

  it("does not overwrite explicit values with weaker inferred values", () => {
    const result = decide(completeState(), {
      destination: { value: "Paris", source: "MODEL_INFERRED" },
      duration: { value: { value: 10, unit: "DAYS" }, source: "DERIVED" }
    });
    expect(result.state.destination).toBe("Dubai");
    expect(result.state.duration).toEqual({ value: 4, unit: "DAYS" });
  });
});
