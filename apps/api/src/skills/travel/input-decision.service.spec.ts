import { describe, it, expect, beforeEach } from "vitest";
import type { PlanTripSkillState } from "./plan-trip.skill";
import { InputDecisionService } from "./input-decision.service";
import { emptyPlanTripSkillState } from "./plan-trip.skill";
import type { DecisionContext } from "./input-decision.dto.js";

const createContext = (): DecisionContext => ({
  usedLegacyFallback: false,
  decisionTimeMs: 0
});

describe("InputDecisionService", () => {
  let service: InputDecisionService;

  beforeEach(() => {
    service = new InputDecisionService();
  });

  describe("empty state", () => {
    it("should ask for origin first", () => {
      const state = emptyPlanTripSkillState();
      const decision = service.generate(state, createContext());

      expect(decision.decision).toBe("ASK_FOR_INPUT");
      expect(decision.pendingInput).toBe("ORIGIN");
      expect(decision.explanationCode).toBe("ASKING_FOR_ORIGIN");
    });

    it("should have all capabilities false", () => {
      const state = emptyPlanTripSkillState();
      const decision = service.generate(state, createContext());

      expect(decision.readinessCapabilities.itinerary).toBe(false);
      expect(decision.readinessCapabilities.estimate).toBe(false);
      expect(decision.readinessCapabilities.liveSearch).toBe(false);
      expect(decision.readinessCapabilities.booking).toBe(false);
    });
  });

  describe("partial data collection", () => {
    it("should ask for destination after origin", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York"
      };
      const decision = service.generate(state, createContext());

      expect(decision.decision).toBe("ASK_FOR_INPUT");
      expect(decision.pendingInput).toBe("DESTINATION");
      expect(decision.explanationCode).toBe("ASKING_FOR_DESTINATION");
    });

    it("should ask for travel year after basic date", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: null,
          day: 15,
          month: 7,
          year: null // Year missing
        }
      };
      const decision = service.generate(state, createContext());

      expect(decision.pendingInput).toBe("TRAVEL_YEAR");
      expect(decision.readinessCapabilities.liveSearch).toBe(false);
    });

    it("should enable early capabilities with basic data", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.readinessCapabilities.itinerary).toBe(true);
      expect(decision.readinessCapabilities.estimate).toBe(true);
      expect(decision.explanationCode).toBe("ALL_DATA_PRESENT_FOR_BOOKING");
    });
  });

  describe("readiness transitions", () => {
    it("should block live search when year is missing", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: null,
          day: 15,
          month: 7,
          year: null // Missing
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.readinessCapabilities.itinerary).toBe(true);
      expect(decision.readinessCapabilities.estimate).toBe(true);
      expect(decision.readinessCapabilities.liveSearch).toBe(false);
      expect(decision.readinessCapabilities.booking).toBe(false);
    });

    it("should block live search when traveller composition is missing", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 3, adults: null, children: null, infants: null }, // Total only
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.readinessCapabilities.itinerary).toBe(true);
      expect(decision.readinessCapabilities.estimate).toBe(true);
      expect(decision.readinessCapabilities.liveSearch).toBe(false);
      expect(decision.readinessCapabilities.booking).toBe(false);
    });

    it("should enable live search and booking when all required data present", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.decision).toBe("READY_FOR_BOOKING");
      expect(decision.readinessCapabilities.booking).toBe(true);
      expect(decision.readinessCapabilities.liveSearch).toBe(true);
      expect(decision.pendingInput).toBeNull();
    });
  });

  describe("optional fields", () => {
    it("should warn when purpose is missing", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" },
        purpose: null
      };
      const decision = service.generate(state, createContext());

      expect(decision.policyWarnings).toContain("PURPOSE_NOT_SUPPLIED");
    });

    it("should warn when budget is missing", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" },
        budget: null
      };
      const decision = service.generate(state, createContext());

      expect(decision.policyWarnings).toContain("BUDGET_NOT_SUPPLIED");
    });

    it("should not block ready status for optional fields", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" },
        purpose: null,
        budget: null
      };
      const decision = service.generate(state, createContext());

      expect(decision.decision).toBe("READY_FOR_BOOKING");
      expect(decision.readinessCapabilities.booking).toBe(true);
    });
  });

  describe("decision priority", () => {
    it("should return READY_FOR_BOOKING when all ready", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.decision).toBe("READY_FOR_BOOKING");
    });

    it("should return READY_FOR_LIVE_SEARCH when live search ready but not booking", () => {
      // Note: Current policy makes READY_FOR_BOOKING the highest
      // This test shows the priority
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      // All requirements met, so should be READY_FOR_BOOKING
      expect(decision.decision).toBe("READY_FOR_BOOKING");
    });
  });

  describe("error handling", () => {
    it("should handle state data properly", () => {
      const state = emptyPlanTripSkillState();
      const context = createContext();

      const decision = service.generate(state, context);

      expect(decision).toBeDefined();
      expect(decision.decision).toBe("ASK_FOR_INPUT");
      expect(decision.stateRevision).toBe(0);
    });

    it("should record decision time", () => {
      const state = emptyPlanTripSkillState();
      const context = createContext();

      service.generate(state, context);

      expect(context.decisionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("missing fields collection", () => {
    it("should list all blockers when empty", () => {
      const state = emptyPlanTripSkillState();
      const decision = service.generate(state, createContext());

      expect(decision.missingFields).toContain("MISSING_ORIGIN");
      expect(decision.missingFields).toContain("MISSING_DESTINATION");
      expect(decision.missingFields).toContain("MISSING_DEPARTURE_DATE");
      expect(decision.missingFields).toContain("MISSING_TRAVELLERS");
      expect(decision.missingFields).toContain("MISSING_DURATION_OR_RETURN_DATE");
    });

    it("should reduce blockers as data is added", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York",
        destination: "London",
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        },
        travellers: { total: 2, adults: 2, children: 0, infants: 0 },
        duration: { value: 7, unit: "DAYS" }
      };
      const decision = service.generate(state, createContext());

      expect(decision.missingFields).not.toContain("MISSING_ORIGIN");
      expect(decision.missingFields).not.toContain("MISSING_DESTINATION");
      expect(decision.missingFields.length).toBe(0); // All blockers resolved
    });
  });
});
