import { describe, it, expect } from "vitest";
import {
  detectSprintIntent,
  extractOriginCity,
  mergeEntitiesWithPriorState,
  determineMissingFields,
  extractRoundTrip,
  extractTripType
} from "./sprint-4.4b-integration";
import { EMPTY_TRAVEL_ENTITIES, type TravelEntities } from "./travel.runtime";

describe("Sprint 4.4B Integration", () => {

  describe("detectSprintIntent", () => {
    it("detects booking intent for 'book the ticket'", () => {
      const result = detectSprintIntent("Book the ticket", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'Book my hotels and flights'", () => {
      const result = detectSprintIntent("Book my hotels and flights", "COLLECTING_DETAILS");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'book my flight'", () => {
      const result = detectSprintIntent("book my flight", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'confirm this option'", () => {
      const result = detectSprintIntent("confirm this option", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'proceed with booking'", () => {
      const result = detectSprintIntent("proceed with booking", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'I want to book'", () => {
      const result = detectSprintIntent("I want to book", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'confirm my trip'", () => {
      const result = detectSprintIntent("confirm my trip", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it("detects booking intent for 'go ahead'", () => {
      const result = detectSprintIntent("go ahead", "RECOMMENDATION_PRESENTED");
      expect(result.intent).toBe("BOOKING_INTENT");
    });

    it.each(["book", "Book", "book.", "book!", "book it", "book this", "book now", "please book", "okay, book"])(
      "detects booking intent for a bare '%s' reply",
      (message) => {
        const result = detectSprintIntent(message, "RECOMMENDATION_PRESENTED");
        expect(result.intent).toBe("BOOKING_INTENT");
      }
    );

    it("does not treat 'book' appearing mid-sentence as booking intent (would already be caught by the noun-anchored patterns if genuine)", () => {
      const result = detectSprintIntent("I read a great book about Dubai", "RECOMMENDATION_PRESENTED");
      expect(result.intent).not.toBe("BOOKING_INTENT");
    });

    it("does not detect booking intent when already booked", () => {
      const result = detectSprintIntent("Book the ticket", "BOOKED");
      expect(result.intent).not.toBe("BOOKING_INTENT");
    });

    it("detects cancellation intent for 'cancel my booking'", () => {
      const result = detectSprintIntent("cancel my booking", "BOOKED");
      expect(result.intent).toBe("CANCELLATION_INTENT");
    });

    it("detects cancellation intent for 'cancel the ticket'", () => {
      const result = detectSprintIntent("I want to cancel this trip", "BOOKED");
      expect(result.intent).toBe("CANCELLATION_INTENT");
    });

    it("detects cancellation intent for 'Cancel my booking'", () => {
      const result = detectSprintIntent("Cancel my booking", "BOOKED");
      expect(result.intent).toBe("CANCELLATION_INTENT");
    });

    it("detects budget change intent", () => {
      const result = detectSprintIntent("I can increase the budget", "COLLECTING_DETAILS");
      expect(result.intent).toBe("BUDGET_CHANGE");
    });

    it("detects budget change intent with specific amount", () => {
      const result = detectSprintIntent("Increase it to INR 400000", "COLLECTING_DETAILS");
      expect(result.intent).toBe("BUDGET_CHANGE");
    });

    it("detects budget flexible", () => {
      const result = detectSprintIntent("budget is flexible", "COLLECTING_DETAILS");
      expect(result.intent).toBe("BUDGET_FLEXIBLE");
    });

    it("detects re-evaluation request", () => {
      const result = detectSprintIntent("I told you earlier", "COLLECTING_DETAILS");
      expect(result.intent).toBe("RE_EVALUATION_REQUEST");
    });

    it("detects re-evaluation request for Hinglish", () => {
      const result = detectSprintIntent("maine pehle bata diya tha", "COLLECTING_DETAILS");
      expect(result.intent).toBe("RE_EVALUATION_REQUEST");
    });

    it("returns NONE for irrelevant text", () => {
      const result = detectSprintIntent("what's the weather like?", "COLLECTING_DETAILS");
      expect(result.intent).toBe("NONE");
    });
  });

  describe("extractRoundTrip", () => {
    it("detects 'round trip'", () => {
      expect(extractRoundTrip("book round trip")).toBe(true);
    });

    it("detects 'return ticket'", () => {
      expect(extractRoundTrip("return ticket please")).toBe(true);
    });

    it("detects 'return flight'", () => {
      expect(extractRoundTrip("I need a return flight")).toBe(true);
    });

    it("detects 'both ways'", () => {
      expect(extractRoundTrip("book both ways")).toBe(true);
    });

    it("returns false for non-round-trip text", () => {
      expect(extractRoundTrip("one way ticket")).toBe(false);
    });
  });

  describe("extractTripType", () => {
    it("returns ROUND_TRIP for 'round trip'", () => {
      expect(extractTripType("book round trip")).toBe("ROUND_TRIP");
    });

    it("returns ROUND_TRIP for '3 adult, and book round trip'", () => {
      expect(extractTripType("3 adult, and book round trip")).toBe("ROUND_TRIP");
    });

    it("returns ONE_WAY for 'one way'", () => {
      expect(extractTripType("one way ticket")).toBe("ONE_WAY");
    });

    it("returns null for non-trip-type text", () => {
      expect(extractTripType("book my ticket")).toBeNull();
    });
  });

  describe("extractOriginCity", () => {
    it("extracts origin from 'from Delhi'", () => {
      const result = extractOriginCity("12 August 2026 from Delhi");
      expect(result).toBe("Delhi");
    });

    it("extracts origin from 'from New York'", () => {
      const result = extractOriginCity("from New York");
      expect(result).toBe("New York");
    });

    it("returns null for destination-only text", () => {
      const result = extractOriginCity("I want to go to Dubai");
      expect(result).toBeNull();
    });
  });

  describe("entity persistence", () => {
    it("preserves entities from first message when name is collected", () => {
      const prior: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        destinationCity: "Dubai",
        adults: 2,
        days: 5,
        budget: 50000,
        budgetCurrency: "AED"
      };

      const result = mergeEntitiesWithPriorState(
        prior,
        "Krishna",
        ["Plan Dubai trip for 2 adults for 5 days with AED 50000", "Krishna"],
        null,
        "USD"
      );

      expect(result.destinationCity).toBe("Dubai");
      expect(result.adults).toBe(2);
      expect(result.days).toBe(5);
      expect(result.budget).toBe(50000);
      expect(result.budgetCurrency).toBe("AED");
      expect(result.customerName).toBe("Krishna");
    });

    it("merges origin without overwriting destination", () => {
      const prior: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        destinationCity: "Dubai",
        adults: 2,
        days: 5,
        budget: 50000,
        budgetCurrency: "AED"
      };

      const result = mergeEntitiesWithPriorState(
        prior,
        "12 August 2026 from Delhi",
        ["Plan Dubai trip", "12 August 2026 from Delhi"],
        "Where are you traveling from?",
        "USD"
      );

      expect(result.originCity).toBe("Delhi");
      expect(result.destinationCity).toBe("Dubai");
    });

    it("handles corrections correctly", () => {
      const prior: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        destinationCity: "Dubai",
        adults: 2,
        days: 5,
        budget: 50000,
        budgetCurrency: "AED"
      };

      const result = mergeEntitiesWithPriorState(
        prior,
        "Actually make it 4 adults",
        ["Plan Dubai trip", "Actually make it 4 adults"],
        null,
        "USD"
      );

      expect(result.adults).toBe(4);
      expect(result.destinationCity).toBe("Dubai");
      expect(result.days).toBe(5);
    });

    it("extracts an exact departureDate from an abbreviated month with a 2-digit year (reproduces the 'dates to be confirmed' UAT bug — '1 Oct 2026' previously only set travelMonth, never the exact date, because the hand-rolled regex here required a full month name and a 4-digit year)", () => {
      const prior: TravelEntities = { ...EMPTY_TRAVEL_ENTITIES, destinationCity: "Singapore" };
      const result = mergeEntitiesWithPriorState(
        prior,
        "1 Oct 2026",
        ["Plan trip to Singapore", "1 Oct 2026"],
        null,
        "USD"
      );
      expect(result.departureDate).toBe("2026-10-01");
      expect(result.travelMonth).toBe("October");
    });

    it("preserves destination and origin through conversation", () => {
      let state: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        destinationCity: "Dubai",
        adults: 2,
        days: 5,
        budget: 50000,
        budgetCurrency: "AED"
      };

      state = mergeEntitiesWithPriorState(state, "Delhi", ["Plan Dubai trip", "Delhi"], "Where are you traveling from?", "USD");
      expect(state.originCity).toBe("Delhi");
      expect(state.destinationCity).toBe("Dubai");

      state = mergeEntitiesWithPriorState(state, "3 adults", ["Plan Dubai trip", "Delhi", "3 adults"], null, "USD");
      expect(state.adults).toBe(3);
      expect(state.originCity).toBe("Delhi");
      expect(state.destinationCity).toBe("Dubai");
    });
  });

  describe("missing fields", () => {
    it("returns empty when all fields present", () => {
      const entities: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        customerName: "Krishna",
        originCity: "Delhi",
        destinationCity: "Dubai",
        departureDate: "2026-08-12",
        days: 5,
        adults: 3,
        budget: 100000,
        budgetCurrency: "AED"
      };
      expect(determineMissingFields(entities)).toHaveLength(0);
    });

    it("lists missing fields", () => {
      const entities: TravelEntities = {
        ...EMPTY_TRAVEL_ENTITIES,
        destinationCity: "Dubai"
      };
      const missing = determineMissingFields(entities);
      expect(missing).toContain("customerName");
      expect(missing).toContain("originCity");
      expect(missing).toContain("departureDate");
      expect(missing).toContain("duration");
      expect(missing).toContain("travellers");
      expect(missing).toContain("budget");
    });
  });

  describe("exact failed conversation scenario", () => {
    it("detects BOOKING_INTENT at 'Book my hotels and flights'", () => {
      const intent = detectSprintIntent("Book my hotels and flights", "COLLECTING_DETAILS");
      expect(intent.intent).toBe("BOOKING_INTENT");
    });

    it("detects BOOKING_INTENT at 'book round trip'", () => {
      const intent = detectSprintIntent("3 adult, and book round trip", "COLLECTING_DETAILS");
      expect(intent.intent).toBe("BOOKING_INTENT");
    });

    it("detects BOOKING_INTENT at 'Book my ticket'", () => {
      const intent = detectSprintIntent("Book my ticket", "RECOMMENDATION_PRESENTED");
      expect(intent.intent).toBe("BOOKING_INTENT");
    });

    it("booking intent takes priority over generic recommendation generation", () => {
      const genericRecommendationText = "I need round trip";
      const bookingText = "Book my ticket";

      const genericIntent = detectSprintIntent(genericRecommendationText, "RECOMMENDATION_PRESENTED");
      const bookingIntent = detectSprintIntent(bookingText, "RECOMMENDATION_PRESENTED");

      expect(genericIntent.intent).toBe("NONE");
      expect(bookingIntent.intent).toBe("BOOKING_INTENT");
    });

    it("booking intent does NOT fire for 'I need round trip' alone", () => {
      const result = detectSprintIntent("I need round trip", "RECOMMENDATION_PRESENTED");
      expect(result.intent).not.toBe("BOOKING_INTENT");
    });
  });
});
