import { describe, it, expect, vi } from "vitest";
import { CapabilityExecutionAdapter } from "./capability-execution.adapter";
import { TravelDecisionAdapter } from "./travel-decision-adapter";
import type { InputDecision } from "./input-decision.dto";
import type { CapabilityExecutionContext } from "./capability-execution.dto";
import { EMPTY_TRAVEL_ENTITIES, DEFAULT_TRAVEL_EMPLOYEE_CONFIG } from "../../travel/travel.runtime";

/**
 * Stage 9A: CapabilityExecutionAdapter unit tests.
 *
 * Proves the adapter is a pure dispatcher: exactly one collaborator is invoked per capability, mapping
 * is deterministic, booking never executes anything, and a collaborator failure degrades to a typed
 * FAILED decision rather than throwing (so the caller can fall back to legacy Travel Runtime).
 */

function readyDecision(capability: keyof InputDecision["readinessCapabilities"], decision: InputDecision["decision"]): InputDecision {
  return {
    decision,
    pendingInput: null,
    missingFields: [],
    readinessCapabilities: {
      itinerary: capability === "itinerary",
      estimate: capability === "estimate",
      liveSearch: capability === "liveSearch",
      booking: capability === "booking"
    },
    policyWarnings: [],
    explanationCode: "READY",
    skillVersion: "1.0.0",
    policyVersion: "1.0.0",
    stateRevision: 1
  };
}

function context(overrides: Partial<CapabilityExecutionContext["entities"]> = {}): CapabilityExecutionContext {
  return {
    entities: { ...EMPTY_TRAVEL_ENTITIES, ...overrides },
    config: DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
    displayCurrency: "USD"
  };
}

describe("CapabilityExecutionAdapter", () => {
  describe("READY_FOR_ITINERARY", () => {
    it("calls only the itinerary collaborator", () => {
      const estimateBudget = vi.fn();
      const describeItineraryDelegation = vi.fn().mockReturnValue({ target: "orchestrator.itinerary", reason: "test" });
      const prepareLiveSearch = vi.fn();
      const adapter = new CapabilityExecutionAdapter(estimateBudget, describeItineraryDelegation, prepareLiveSearch);

      const route = TravelDecisionAdapter.route(readyDecision("itinerary", "READY_FOR_ITINERARY"));
      const decision = adapter.execute(route, context());

      expect(describeItineraryDelegation).toHaveBeenCalledOnce();
      expect(estimateBudget).not.toHaveBeenCalled();
      expect(prepareLiveSearch).not.toHaveBeenCalled();
      expect(decision.capability).toBe("ITINERARY");
      expect(decision.executionStatus).toBe("DELEGATED");
      expect(decision.executionType).toBe("LLM_ORCHESTRATED");
      expect(decision.executionTarget).toBe("orchestrator.itinerary");
      expect(decision.requiresWorkflow).toBe(false);
      expect(decision.requiresHumanApproval).toBe(false);
    });
  });

  describe("READY_FOR_ESTIMATE", () => {
    it("calls only the estimate service and returns a real computed estimate", () => {
      const estimateBudget = vi.fn().mockReturnValue({ currency: "USD", low: 1000, high: 2000, breakdown: [] });
      const describeItineraryDelegation = vi.fn();
      const prepareLiveSearch = vi.fn();
      const adapter = new CapabilityExecutionAdapter(estimateBudget, describeItineraryDelegation, prepareLiveSearch);

      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));
      const decision = adapter.execute(route, context({ destinationCity: "London" }));

      expect(estimateBudget).toHaveBeenCalledOnce();
      expect(estimateBudget).toHaveBeenCalledWith(
        expect.objectContaining({ destinationCity: "London" }),
        DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
        "USD"
      );
      expect(describeItineraryDelegation).not.toHaveBeenCalled();
      expect(prepareLiveSearch).not.toHaveBeenCalled();
      expect(decision.capability).toBe("ESTIMATE");
      expect(decision.executionStatus).toBe("EXECUTED");
      expect(decision.executionType).toBe("DETERMINISTIC_CALCULATION");
      expect(decision.executionTarget).toBe("estimateBudgetRange");
      expect(decision.metadata.estimate).toEqual({ currency: "USD", low: 1000, high: 2000, breakdown: [] });
    });

    it("uses the real estimateBudgetRange function by default (no injected collaborator)", () => {
      const adapter = new CapabilityExecutionAdapter();
      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));

      const decision = adapter.execute(
        route,
        context({ destinationCity: "Dubai", originCity: "Delhi", days: 5, totalTravellers: 2, adults: 2 })
      );

      expect(decision.executionStatus).toBe("EXECUTED");
      const estimate = decision.metadata.estimate as { low: number; high: number; currency: string };
      expect(estimate.low).toBeGreaterThan(0);
      expect(estimate.high).toBeGreaterThanOrEqual(estimate.low);
      expect(estimate.currency).toBe("USD");
    });
  });

  describe("READY_FOR_LIVE_SEARCH", () => {
    it("calls only the search preparation collaborator, never executing a real search", () => {
      const estimateBudget = vi.fn();
      const describeItineraryDelegation = vi.fn();
      const prepareLiveSearch = vi.fn().mockReturnValue({
        target: "travel.liveSearch",
        tools: ["travel.search_flights", "travel.search_hotels"],
        destination: "Goa",
        travelMonth: "December"
      });
      const adapter = new CapabilityExecutionAdapter(estimateBudget, describeItineraryDelegation, prepareLiveSearch);

      const route = TravelDecisionAdapter.route(readyDecision("liveSearch", "READY_FOR_LIVE_SEARCH"));
      const decision = adapter.execute(route, context({ destinationCity: "Goa" }));

      expect(prepareLiveSearch).toHaveBeenCalledOnce();
      expect(estimateBudget).not.toHaveBeenCalled();
      expect(describeItineraryDelegation).not.toHaveBeenCalled();
      expect(decision.capability).toBe("LIVE_SEARCH");
      expect(decision.executionStatus).toBe("PREPARED");
      expect(decision.executionType).toBe("TOOL_DELEGATED");
      expect(decision.executionTarget).toBe("travel.liveSearch");
      expect(decision.metadata.tools).toEqual(["travel.search_flights", "travel.search_hotels"]);
    });
  });

  describe("READY_FOR_BOOKING", () => {
    it("does not call any collaborator and returns a typed BOOKING_WORKFLOW_PENDING decision", () => {
      const estimateBudget = vi.fn();
      const describeItineraryDelegation = vi.fn();
      const prepareLiveSearch = vi.fn();
      const adapter = new CapabilityExecutionAdapter(estimateBudget, describeItineraryDelegation, prepareLiveSearch);

      const route = TravelDecisionAdapter.route(readyDecision("booking", "READY_FOR_BOOKING"));
      expect(route.action).toBe("BOOKING_WORKFLOW_PENDING");

      const decision = adapter.execute(route, context());

      expect(estimateBudget).not.toHaveBeenCalled();
      expect(describeItineraryDelegation).not.toHaveBeenCalled();
      expect(prepareLiveSearch).not.toHaveBeenCalled();
      expect(decision.capability).toBe("BOOKING");
      expect(decision.executionStatus).toBe("EXECUTABLE");
      expect(decision.executionType).toBe("WORKFLOW_READY");
      expect(decision.executionTarget).toBe("bookingWorkflow");
      expect(decision.requiresWorkflow).toBe(true);
      expect(decision.requiresHumanApproval).toBe(true);
      expect(decision.metadata).toEqual({ bookingSupported: true, workflowRequired: true, requiresCustomerApproval: true });
    });
  });

  describe("non-capability routes", () => {
    it.each([
      ["ASK_FOR_INPUT" as const, "ASK_QUESTION"],
      ["ERROR_VALIDATION_FAILED" as const, "SKILL_ERROR"],
      ["ERROR_STATE_LOSS" as const, "LEGACY_FALLBACK"]
    ])("returns NOT_APPLICABLE for %s and calls no collaborator", (decisionType, expectedAction) => {
      const estimateBudget = vi.fn();
      const describeItineraryDelegation = vi.fn();
      const prepareLiveSearch = vi.fn();
      const adapter = new CapabilityExecutionAdapter(estimateBudget, describeItineraryDelegation, prepareLiveSearch);

      const decision: InputDecision = {
        decision: decisionType,
        pendingInput: decisionType === "ASK_FOR_INPUT" ? "ORIGIN" : null,
        missingFields: [],
        readinessCapabilities: { itinerary: false, estimate: false, liveSearch: false, booking: false },
        policyWarnings: [],
        explanationCode: "TEST",
        skillVersion: "1.0.0",
        policyVersion: "1.0.0",
        stateRevision: 0
      };
      const route = TravelDecisionAdapter.route(decision);
      expect(route.action).toBe(expectedAction);

      const result = adapter.execute(route, context());

      expect(estimateBudget).not.toHaveBeenCalled();
      expect(describeItineraryDelegation).not.toHaveBeenCalled();
      expect(prepareLiveSearch).not.toHaveBeenCalled();
      expect(result.capability).toBe("NOT_APPLICABLE");
      expect(result.executionStatus).toBe("NOT_APPLICABLE");
      expect(result.requiresWorkflow).toBe(false);
      expect(result.requiresHumanApproval).toBe(false);
    });
  });

  describe("fallback on failure", () => {
    it("never throws: a collaborator failure becomes a typed FAILED decision with structured diagnostics", () => {
      const estimateBudget = vi.fn().mockImplementation(() => {
        throw new Error("BUDGET_ENGINE_UNAVAILABLE");
      });
      const adapter = new CapabilityExecutionAdapter(estimateBudget, vi.fn(), vi.fn());

      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));

      const decision = adapter.execute(route, context());

      expect(decision.executionStatus).toBe("FAILED");
      expect(decision.executionType).toBe("NONE");
      expect(decision.executionTarget).toBeNull();
      expect(decision.capability).toBe("ESTIMATE");
      expect(decision.metadata.error).toBe("BUDGET_ENGINE_UNAVAILABLE");
    });

    it("a single failure results in exactly one collaborator attempt, never a retry", () => {
      const estimateBudget = vi.fn().mockImplementation(() => {
        throw new Error("boom");
      });
      const adapter = new CapabilityExecutionAdapter(estimateBudget, vi.fn(), vi.fn());
      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));

      adapter.execute(route, context());

      expect(estimateBudget).toHaveBeenCalledOnce();
    });
  });

  describe("deterministic capability mapping", () => {
    it("maps the same route+context to an identical decision on repeated calls", () => {
      const adapter = new CapabilityExecutionAdapter();
      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));
      const ctx = context({ destinationCity: "London", originCity: "Delhi", days: 4, totalTravellers: 1, adults: 1 });

      const first = adapter.execute(route, ctx);
      const second = adapter.execute(route, ctx);

      expect(first).toEqual(second);
    });

    it("never invokes the same capability's collaborator more than once for a single execute() call", () => {
      const estimateBudget = vi.fn().mockReturnValue({ currency: "USD", low: 1, high: 2, breakdown: [] });
      const adapter = new CapabilityExecutionAdapter(estimateBudget, vi.fn(), vi.fn());
      const route = TravelDecisionAdapter.route(readyDecision("estimate", "READY_FOR_ESTIMATE"));

      adapter.execute(route, context());

      expect(estimateBudget.mock.calls.length).toBe(1);
    });
  });
});
