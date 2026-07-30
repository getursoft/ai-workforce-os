import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  buildIndicativeFlightGuidance,
  buildIndicativeRecommendationsMessage,
  estimateBudgetRange,
  formatScopedAmount,
  type TravelEntities
} from "./travel.runtime";

/**
 * Stage 9B: AmountScope correctness — regression coverage for the real UAT defect where a TOTAL_PARTY
 * flight estimate (for 5 adults) was shown labeled "per traveler", and for the missing budget-vs-estimate
 * comparison on the indicative-recommendations path.
 */

describe("formatScopedAmount", () => {
  it("labels a PER_TRAVELLER amount distinctly from a TOTAL_PARTY amount for the same numbers", () => {
    const perTraveller = formatScopedAmount({ low: 100, high: 200 }, "USD", "PER_TRAVELLER");
    const total = formatScopedAmount({ low: 100, high: 200 }, "USD", "TOTAL_PARTY", "ENGLISH", 5);
    expect(perTraveller).toContain("per traveler");
    expect(total).not.toContain("per traveler");
    expect(total).toContain("total");
  });

  it("labels PER_NIGHT and TOTAL_STAY distinctly", () => {
    expect(formatScopedAmount({ low: 10, high: 20 }, "USD", "PER_NIGHT")).toContain("per night");
    expect(formatScopedAmount({ low: 10, high: 20 }, "USD", "TOTAL_STAY")).toContain("full stay");
  });
});

describe("buildIndicativeFlightGuidance: never presents a TOTAL_PARTY flight amount as PER_TRAVELLER", () => {
  const uatTrip: TravelEntities = {
    ...EMPTY_TRAVEL_ENTITIES,
    originCity: "Delhi",
    destinationCity: "Dubai",
    days: 3,
    travelMonth: "August",
    adults: 5,
    totalTravellers: 5,
    budget: 500000,
    budgetCurrency: "INR"
  };

  it("shows the PER_TRAVELLER-scoped amount, not the 5-traveller TOTAL_PARTY amount, for 5 adults", () => {
    const estimate = estimateBudgetRange(uatTrip, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, "INR");
    const flightsLine = estimate.breakdown.find((line) => line.label === "Flights");
    expect(flightsLine).toBeDefined();
    expect(flightsLine?.perTraveller).toBeDefined();
    const perTraveller = flightsLine?.perTraveller ?? { low: 0, high: 0 };
    // The total-party amount is materially larger than the per-traveller amount for 5 farePayers —
    // ground truth that these are genuinely different numbers, not a rounding coincidence.
    expect(flightsLine?.low ?? 0).toBeGreaterThan(perTraveller.low * 4);

    const message = buildIndicativeFlightGuidance(uatTrip, estimate, "ENGLISH");

    const perTravellerText = `${estimate.currency} ${Math.round(perTraveller.low).toLocaleString("en-US")}`;
    const totalPartyText = `${estimate.currency} ${Math.round(flightsLine?.low ?? 0).toLocaleString("en-US")}`;
    expect(message).toContain(perTravellerText);
    // The party TOTAL must never appear as the number attached to "per traveler" wording.
    if (totalPartyText !== perTravellerText) expect(message).not.toContain(totalPartyText);
    expect(message).toMatch(/per traveler/i);
  });
});

describe("buildIndicativeRecommendationsMessage: total trip estimate vs total budget comparison", () => {
  it("clearly states how the traveler's total budget compares to the total trip estimate when it falls short", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "Dubai",
      days: 3,
      travelMonth: "August",
      adults: 5,
      totalTravellers: 5,
      budget: 500000,
      budgetCurrency: "INR"
    };
    const estimate = estimateBudgetRange(trip, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, "INR");
    // Ground truth for this scenario: the total party estimate exceeds the stated total budget.
    expect(500000).toBeLessThan(estimate.low);
    const message = buildIndicativeRecommendationsMessage(trip, estimate, "ENGLISH", true);

    // The shortfall must be stated clearly (tight-but-workable or below-minimum wording, whichever the
    // existing classifier picks) — never silently omitted the way this path previously did.
    expect(message).toMatch(/tight|minimum|below|short/i);
    expect(message).toContain("INR 500,000");
  });

  it("confirms feasibility when the budget comfortably covers the total estimate", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Delhi",
      destinationCity: "Goa",
      days: 3,
      travelMonth: "August",
      adults: 1,
      totalTravellers: 1,
      budget: 10_000_000,
      budgetCurrency: "INR"
    };
    const estimate = estimateBudgetRange(trip, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, "INR");
    expect(10_000_000).toBeGreaterThan(estimate.low);
    const message = buildIndicativeRecommendationsMessage(trip, estimate, "ENGLISH", false);
    expect(message).toMatch(/comfortable/i);
  });

  it("omits any budget comparison line when no budget was stated (regression safety)", () => {
    const trip: TravelEntities = {
      ...EMPTY_TRAVEL_ENTITIES,
      originCity: "Milan",
      destinationCity: "Rome",
      days: 4,
      travelMonth: "June",
      adults: 2,
      budgetCurrency: "USD"
    };
    const estimate = estimateBudgetRange(trip, DEFAULT_TRAVEL_EMPLOYEE_CONFIG);
    const message = buildIndicativeRecommendationsMessage(trip, estimate, "ENGLISH", false);
    expect(message).not.toMatch(/comfortable|minimum budget/i);
  });
});
