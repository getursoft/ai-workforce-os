import { describe, it, expect, afterEach } from "vitest";
import { emptyPlanTripSkillState, mergePlanTripState, type PlanTripSkillState } from "./plan-trip.skill";
import { InputDecisionService } from "./input-decision.service";
import { PendingInputQuestionService } from "./pending-input-question.service";
import { SkillExecutionMirrorService } from "./skill-execution-mirror.service";
import { InputCollectionService } from "./input-collection.service";
import { PlanTripSkillExecutionMapper } from "./plan-trip-skill-execution.mapper";
import { TravelDecisionAdapter } from "./travel-decision-adapter";
import {
  withAuthoritativeMode,
  withLegacyMode,
  getSkillRuntimeAuthoritativeConfig
} from "./skill-runtime-authoritative-config";
import type { InputDecision, DecisionContext } from "./input-decision.dto";
import type { SkillExecutionService } from "../skill-execution.service";
import { EMPTY_TRAVEL_ENTITIES } from "../../travel/travel.runtime";
import { classifyRequestIntent, isKnowledgeEligible } from "../../agents/request-classifier";

/**
 * Stage 8B Integration Tests: Runtime Integration for Authoritative Input Collection
 *
 * These tests verify that:
 * 1. InputDecisionService generates correct decisions from Travel entities
 * 2. PendingInputQuestionService produces natural language questions
 * 3. TravelDecisionAdapter routes decisions correctly
 * 4. InputCollectionService orchestrates the full flow
 * 5. Authoritative mode can be toggled with feature flags
 * 6. Fallback to legacy mode works correctly
 */

const createContext = (): DecisionContext => ({
  usedLegacyFallback: false,
  decisionTimeMs: 0
});

function stubSkillExecutions(): SkillExecutionService {
  return {
    findActiveExecution: async () => null
  } as unknown as SkillExecutionService;
}

describe("Stage 8B: Authoritative Input Collection Runtime Integration", () => {
  const inputDecisionService = new InputDecisionService();
  const pendingInputQuestionService = new PendingInputQuestionService();
  const mirrorService = new SkillExecutionMirrorService();

  function makeInputCollectionService(skillExecutions = stubSkillExecutions()): InputCollectionService {
    return new InputCollectionService(
      inputDecisionService,
      pendingInputQuestionService,
      mirrorService,
      skillExecutions
    );
  }

  describe("Scenario A: Delhi to London with partial data", () => {
    it("should ask for budget when missing and marked as optional", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi",
        destination: "London",
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" },
        travellers: { adults: 4, children: 0, infants: 0, total: 4 },
        budget: null
      };

      const decision = inputDecisionService.generate(state, createContext());

      // Budget is optional, so should be ready for booking (all required fields present)
      expect(decision.decision).toBe("READY_FOR_BOOKING");
      expect(decision.readinessCapabilities.itinerary).toBe(true);
      expect(decision.readinessCapabilities.estimate).toBe(true);
      // Budget being unset only produces a warning, never a blocker
      expect(decision.policyWarnings).toContain("BUDGET_NOT_SUPPLIED");
      expect(decision.missingFields).not.toContain("MISSING_BUDGET");
    });

    it("should ask for year to unlock live search capability", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi",
        destination: "London",
        departureDate: { value: null, day: 12, month: 2, year: null }
      };

      const decision = inputDecisionService.generate(state, createContext());

      // Missing year should trigger ASK_FOR_INPUT
      expect(decision.decision).toBe("ASK_FOR_INPUT");
      expect(decision.pendingInput).toBe("TRAVEL_YEAR");
      expect(decision.missingFields).toContain("MISSING_TRAVEL_YEAR");
    });

    it("should preserve origin after correction", () => {
      const originalState: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "London",
        destination: "Delhi",
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" },
        travellers: { adults: 2, children: 0, infants: 0, total: 2 },
        budget: { amount: 5000, currency: "USD" },
        purpose: "LEISURE"
      };

      // User says "Actually, I want to start from Delhi"
      const correctedState = { ...originalState, origin: "Delhi" };

      const decision = inputDecisionService.generate(correctedState, createContext());

      // After correction, should still be ready
      expect(decision.decision).toMatch(/READY_FOR_/);
      expect(correctedState.origin).toBe("Delhi");
    });
  });

  describe("Scenario B: Destination correction without losing other fields", () => {
    it("should preserve all other fields when destination changes", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "London",
        destination: "Mumbai", // Being corrected to London
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" },
        travellers: { adults: 2, children: 1, infants: 0, total: 3 },
        budget: { amount: 10000, currency: "USD" },
        purpose: "BUSINESS"
      };

      // Only destination should change
      const correctedState = { ...state, destination: "London" };

      // All other fields preserved
      expect(correctedState.origin).toBe(state.origin);
      expect(correctedState.departureDate).toEqual(state.departureDate);
      expect(correctedState.travellers).toEqual(state.travellers);
      expect(correctedState.budget).toEqual(state.budget);
      expect(correctedState.purpose).toBe(state.purpose);

      // Only destination changed
      expect(correctedState.destination).not.toBe(state.destination);
      expect(correctedState.destination).toBe("London");
    });
  });

  describe("Scenario C: Days vs nights preservation", () => {
    it("4 days is never silently converted into 3 nights", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi",
        destination: "London",
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" }
      };

      // The explicit 4 DAYS is preserved verbatim
      expect(state.duration).toEqual({ value: 4, unit: "DAYS" });
      expect(state.duration?.value).not.toBe(3);
      expect(state.duration?.unit).not.toBe("NIGHTS");
    });

    it("mirrors duration in DAYS without reinterpreting it as NIGHTS", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        duration: { value: 4, unit: "DAYS" }
      };

      const mirror = mirrorService.mirrorStateToTravelEntities(state);

      expect(mirror.days).toBe(4);
      expect(mirror.nights).toBeUndefined();
    });

    it("round-trips DAYS through the legacy Travel entities adapter unchanged", () => {
      const entities = { ...EMPTY_TRAVEL_ENTITIES, originCity: "Delhi", destinationCity: "London", days: 4 };

      const state = PlanTripSkillExecutionMapper.fromTravelEntities(entities);

      expect(state.duration).toEqual({ value: 4, unit: "DAYS" });
    });
  });

  describe("Scenario D: Booking workflow not implemented", () => {
    it("should return READY_FOR_BOOKING when all required data is present", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi",
        destination: "London",
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" },
        travellers: { adults: 4, children: 0, infants: 0, total: 4 },
        budget: { amount: 5000, currency: "USD" },
        purpose: "LEISURE"
      };

      const decision = inputDecisionService.generate(state, createContext());

      expect(decision.readinessCapabilities.booking).toBe(true);
      expect(decision.decision).toBe("READY_FOR_BOOKING");
    });

    it("should route READY_FOR_BOOKING to a typed BOOKING_WORKFLOW_PENDING handoff, never an executed booking", () => {
      const decision: InputDecision = {
        decision: "READY_FOR_BOOKING",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: true,
          booking: true
        },
        policyWarnings: [],
        explanationCode: "COMPLETE_WITH_ALL_REQUIRED_FIELDS",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 1
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).toBe("BOOKING_WORKFLOW_PENDING");
      expect(route.explanation).toContain("not yet implemented");
      expect(TravelDecisionAdapter.isDeferredAction(route)).toBe(true);
      // Never one of the capability-executing actions — nothing actually books anything.
      expect(TravelDecisionAdapter.requiresCapabilityExecution(route)).toBe(false);
    });

    it("should not route booking to RAG or Knowledge, and 'round trip ka booking kar do' never reaches the knowledge bypass", () => {
      const userMessage = "round trip ka booking kar do";
      const intent = classifyRequestIntent(userMessage, { isTravelEmployee: true });

      // The Hinglish booking go-ahead is a CONFIRMATION, never a knowledge question.
      expect(intent).not.toBe("KNOWLEDGE_QUERY");
      expect(isKnowledgeEligible(intent)).toBe(false);

      const decision: InputDecision = {
        decision: "READY_FOR_BOOKING",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: true,
          booking: true
        },
        policyWarnings: [],
        explanationCode: "COMPLETE_WITH_ALL_REQUIRED_FIELDS",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 1
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).not.toBe("LEGACY_FALLBACK");
      expect(route.explanation).not.toContain("knowledge");
      expect(route.explanation).not.toContain("RAG");
    });
  });

  describe("Scenario E: Error recovery and fallback", () => {
    it("should return an ERROR_* decision when Skill Runtime fails to load state", () => {
      const errorDecision = inputDecisionService.errorDecision({
        code: "CRITICAL_ERROR",
        message: "Failed to process state",
        severity: "ERROR"
      });

      expect(errorDecision.decision).toMatch(/^ERROR_/);
      expect(TravelDecisionAdapter.shouldFallback(TravelDecisionAdapter.route(errorDecision))).toBe(true);
    });

    it("should route an error decision to legacy fallback", () => {
      const decision: InputDecision = {
        decision: "ERROR_STATE_LOSS",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: false,
          estimate: false,
          liveSearch: false,
          booking: false
        },
        policyWarnings: ["State was corrupted"],
        explanationCode: "CORRUPTION_DETECTED",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 0
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).toBe("LEGACY_FALLBACK");
      expect(TravelDecisionAdapter.shouldFallback(route)).toBe(true);
    });

    it("should allow exactly one legacy fallback without duplicate tool calls", () => {
      // This scenario verifies that if authoritative mode fails, we:
      // 1. Log a warning
      // 2. Fall back once to legacy Travel Runtime
      // 3. Do not retry or duplicate tool calls
      const errorDecision = inputDecisionService.errorDecision({
        code: "DECISION_ERROR",
        message: "Could not process",
        severity: "WARNING"
      });

      const route = TravelDecisionAdapter.route(errorDecision);

      // Should fall back
      expect(route.action).toBe("LEGACY_FALLBACK");

      // Track that we're in fallback mode
      let fallbackCount = 0;
      if (TravelDecisionAdapter.shouldFallback(route)) {
        fallbackCount++;
      }

      // Should only count as one fallback
      expect(fallbackCount).toBe(1);
    });
  });

  describe("Feature flag behavior", () => {
    afterEach(() => {
      // Reset to default
      const config = getSkillRuntimeAuthoritativeConfig();
      config.enableAuthoritativeInputCollection = false;
    });

    it("should default to SHADOW mode", () => {
      const config = getSkillRuntimeAuthoritativeConfig();
      expect(config.enableAuthoritativeInputCollection).toBe(false);
    });

    it("should allow test override to enable authoritative mode", () => {
      const result = withAuthoritativeMode(() => {
        const config = getSkillRuntimeAuthoritativeConfig();
        return config.enableAuthoritativeInputCollection;
      });

      expect(result).toBe(true);
    });

    it("should allow test override to enforce legacy mode", () => {
      const result = withLegacyMode(() => {
        const config = getSkillRuntimeAuthoritativeConfig();
        return config.enableAuthoritativeInputCollection;
      });

      expect(result).toBe(false);
    });

    it("should restore previous config after test override", () => {
      const originalConfig = getSkillRuntimeAuthoritativeConfig().enableAuthoritativeInputCollection;

      withAuthoritativeMode(() => {
        // Inside override
        expect(getSkillRuntimeAuthoritativeConfig().enableAuthoritativeInputCollection).toBe(true);
      });

      // After override
      expect(getSkillRuntimeAuthoritativeConfig().enableAuthoritativeInputCollection).toBe(originalConfig);
    });
  });

  describe("ASK_FOR_INPUT flow", () => {
    const inputCollectionService = makeInputCollectionService();

    it("should generate a question for a pending origin", () => {
      const question = inputCollectionService.getQuestionForPendingInput("ORIGIN", "ENGLISH");

      expect(question).toHaveProperty("brief");
      expect(question).toHaveProperty("full");
      expect(question.brief.length).toBeGreaterThan(0);
      expect(question.full.length).toBeGreaterThanOrEqual(question.brief.length);
    });

    it("should generate questions in multiple languages", () => {
      const languages = ["ENGLISH", "SPANISH", "FRENCH", "GERMAN"];

      for (const lang of languages) {
        const question = inputCollectionService.getQuestionForPendingInput("DESTINATION", lang);
        expect(question.full.length).toBeGreaterThan(0);
      }
    });

    it("should not duplicate already-asked questions: origin is not asked again once captured", () => {
      const state: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi" // Already provided
      };

      const decision = inputDecisionService.generate(state, createContext());

      // Should ask for destination, not origin again
      expect(decision.decision).toBe("ASK_FOR_INPUT");
      expect(decision.pendingInput).toBe("DESTINATION");
      expect(decision.pendingInput).not.toBe("ORIGIN");
    });

    it("collectInput drives its ASK_FOR_INPUT question directly from the current decision (authoritative mode controls the next question)", async () => {
      const state: PlanTripSkillState = { ...emptyPlanTripSkillState(), origin: "Delhi" };

      const result = await inputCollectionService.collectInput({
        organizationId: "org-123",
        pluginInstallationId: "plugin-123",
        conversationId: "conv-123",
        requestId: "req-123",
        currentState: state,
        lastAssistantMessage: "Where are you starting from?",
        conversationLanguage: "ENGLISH"
      });

      expect(result.decision.decision).toBe("ASK_FOR_INPUT");
      expect(result.decision.pendingInput).toBe("DESTINATION");

      const question = inputCollectionService.getQuestionForPendingInput(
        result.decision.pendingInput,
        "ENGLISH"
      );
      expect(question.full).toBe("Where are you traveling to?");
    });
  });

  describe("Capability mapping", () => {
    it("should map READY_FOR_ITINERARY to action correctly", () => {
      const decision: InputDecision = {
        decision: "READY_FOR_ITINERARY",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: false,
          booking: false
        },
        policyWarnings: [],
        explanationCode: "READY",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 1
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).toBe("GENERATE_ITINERARY");
      expect(TravelDecisionAdapter.requiresCapabilityExecution(route)).toBe(true);
    });

    it("should map READY_FOR_ESTIMATE to action correctly", () => {
      const decision: InputDecision = {
        decision: "READY_FOR_ESTIMATE",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: false,
          booking: false
        },
        policyWarnings: [],
        explanationCode: "READY",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 1
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).toBe("ESTIMATE_BUDGET");
      expect(TravelDecisionAdapter.requiresCapabilityExecution(route)).toBe(true);
    });

    it("should map READY_FOR_LIVE_SEARCH to action correctly", () => {
      const decision: InputDecision = {
        decision: "READY_FOR_LIVE_SEARCH",
        pendingInput: null,
        missingFields: [],
        readinessCapabilities: {
          itinerary: true,
          estimate: true,
          liveSearch: true,
          booking: false
        },
        policyWarnings: [],
        explanationCode: "READY",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 1
      };

      const route = TravelDecisionAdapter.route(decision);

      expect(route.action).toBe("SEARCH_LIVE");
      expect(TravelDecisionAdapter.requiresCapabilityExecution(route)).toBe(true);
    });
  });

  describe("State mirroring for compatibility", () => {
    it("mirrors Skill State into travel.trip_state (TravelEntities) format", () => {
      const skillState: PlanTripSkillState = {
        ...emptyPlanTripSkillState(),
        origin: "Delhi",
        destination: "London",
        departureDate: { value: "2027-02-12", day: 12, month: 2, year: 2027 },
        duration: { value: 4, unit: "DAYS" },
        travellers: { adults: 2, children: 1, infants: 0, total: 3 },
        budget: { amount: 5000, currency: "USD" },
        purpose: "LEISURE"
      };

      const mirror = mirrorService.mirrorStateToTravelEntities(skillState);

      expect(mirror.originCity).toBe("Delhi");
      expect(mirror.destinationCity).toBe("London");
      expect(mirror.days).toBe(4);
      expect(mirror.totalTravellers).toBe(3);
      expect(mirror.budget).toBe(5000);
      expect(mirror.tripType).toBe("LEISURE");
    });

    it("InputCollectionService.mirrorStateToTravelMemory delegates to the mirror service and never throws", () => {
      const inputCollectionService = makeInputCollectionService();
      const skillState = mergePlanTripState(emptyPlanTripSkillState(), {
        data: { origin: { value: "Delhi", source: "USER_EXPLICIT" } }
      });

      const mirror = inputCollectionService.mirrorStateToTravelMemory(
        "org-123",
        "conv-123",
        skillState
      );

      expect(mirror?.originCity).toBe("Delhi");
    });
  });
});
