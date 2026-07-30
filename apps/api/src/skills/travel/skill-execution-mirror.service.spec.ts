import { describe, it, expect, beforeEach } from "vitest";
import { SkillExecutionMirrorService } from "./skill-execution-mirror.service";
import { emptyPlanTripSkillState } from "./plan-trip.skill";
import type { PlanTripSkillState } from "./plan-trip.skill";

describe("SkillExecutionMirrorService", () => {
  let service: SkillExecutionMirrorService;

  beforeEach(() => {
    service = new SkillExecutionMirrorService();
  });

  describe("basic field mirroring", () => {
    it("should mirror origin city", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "New York"
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.originCity).toBe("New York");
    });

    it("should mirror destination city", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        destination: "London"
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.destinationCity).toBe("London");
    });

    it("should handle null values gracefully", () => {
      const state = emptyPlanTripSkillState();
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.originCity).toBeUndefined();
      expect(mirror.destinationCity).toBeUndefined();
    });
  });

  describe("date mirroring", () => {
    it("should mirror departure date in ISO format", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.departureDate).toBe("2025-07-15");
    });

    it("should mirror travel month from departure date", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        departureDate: {
          value: "2025-07-15",
          day: 15,
          month: 7,
          year: 2025
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.travelMonth).toBe("July");
    });

    it("should mirror return date", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        returnDate: {
          value: "2025-07-22",
          day: 22,
          month: 7,
          year: 2025
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.returnDate).toBe("2025-07-22");
    });

    it("should handle partial dates", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        departureDate: {
          value: null,
          day: 15,
          month: 7,
          year: null // Year missing
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.departureDate).toBeUndefined(); // No full date without year
      expect(mirror.travelMonth).toBe("July");
    });
  });

  describe("duration mirroring", () => {
    it("should mirror duration in days", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        duration: { value: 7, unit: "DAYS" }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.days).toBe(7);
      expect(mirror.nights).toBeUndefined();
    });

    it("should mirror duration in nights", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        duration: { value: 6, unit: "NIGHTS" }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.nights).toBe(6);
      expect(mirror.days).toBeUndefined();
    });
  });

  describe("traveller mirroring", () => {
    it("should mirror total travellers", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        travellers: { total: 5, adults: null, children: null, infants: null }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.totalTravellers).toBe(5);
    });

    it("should mirror traveller composition", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        travellers: { total: 4, adults: 2, children: 1, infants: 1 }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.adults).toBe(2);
      expect(mirror.children).toBe(1);
      expect(mirror.infants).toBe(1);
      expect(mirror.totalTravellers).toBe(4);
    });

    it("should handle partial traveller composition", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        travellers: { total: 3, adults: 2, children: 1, infants: null }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.adults).toBe(2);
      expect(mirror.children).toBe(1);
      expect(mirror.infants).toBeUndefined();
    });
  });

  describe("budget mirroring", () => {
    it("should mirror budget amount and currency", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        budget: { amount: 5000, currency: "USD" }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.budget).toBe(5000);
      expect(mirror.budgetCurrency).toBe("USD");
    });

    it("should handle null budget", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        budget: null
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.budget).toBeUndefined();
      expect(mirror.budgetCurrency).toBeUndefined();
    });
  });

  describe("purpose mirroring", () => {
    it("should mirror purpose as trip type", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        purpose: "LEISURE"
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.tripType).toBe("LEISURE");
    });

    it("should handle null purpose", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        purpose: null
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.tripType).toBeUndefined();
    });
  });

  describe("complete state mirroring", () => {
    it("should mirror all fields from complete state", () => {
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
        returnDate: {
          value: "2025-07-22",
          day: 22,
          month: 7,
          year: 2025
        },
        duration: { value: 7, unit: "DAYS" },
        travellers: { total: 4, adults: 2, children: 1, infants: 1 },
        budget: { amount: 5000, currency: "USD" },
        purpose: "LEISURE"
      };

      const mirror = service.mirrorStateToTravelEntities(state);

      expect(mirror.originCity).toBe("New York");
      expect(mirror.destinationCity).toBe("London");
      expect(mirror.departureDate).toBe("2025-07-15");
      expect(mirror.travelMonth).toBe("July");
      expect(mirror.returnDate).toBe("2025-07-22");
      expect(mirror.days).toBe(7);
      expect(mirror.totalTravellers).toBe(4);
      expect(mirror.adults).toBe(2);
      expect(mirror.children).toBe(1);
      expect(mirror.infants).toBe(1);
      expect(mirror.budget).toBe(5000);
      expect(mirror.budgetCurrency).toBe("USD");
      expect(mirror.tripType).toBe("LEISURE");
    });
  });

  describe("month conversion", () => {
    it("should convert all valid month numbers", () => {
      const months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December"
      ];

      months.forEach((month, index) => {
        const state: PlanTripSkillState = {
          ...emptyPlanTripSkillState(),
          departureDate: {
            value: null,
            day: 1,
            month: index + 1,
            year: 2025
          }
        };
        const mirror = service.mirrorStateToTravelEntities(state);
        expect(mirror.travelMonth).toBe(month);
      });
    });
  });

  describe("date validation", () => {
    it("should not mirror invalid dates", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        departureDate: {
          value: "not-a-date",
          day: 15,
          month: 7,
          year: 2025
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.departureDate).toBeUndefined();
    });

    it("should not mirror dates with missing year", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        departureDate: {
          value: null,
          day: 15,
          month: 7,
          year: null
        }
      };
      const mirror = service.mirrorStateToTravelEntities(state);
      expect(mirror.departureDate).toBeUndefined();
    });
  });
});
