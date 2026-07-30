import { Injectable, Logger, Optional } from "@nestjs/common";
import { estimateBudgetRange } from "../../travel/travel.runtime";
import type { TravelDecisionRoute } from "./travel-decision-adapter";
import type {
  BudgetEstimationFn,
  CapabilityExecutionContext,
  ExecutionDecision,
  ItineraryDelegationFn,
  LiveSearchPreparationFn
} from "./capability-execution.dto";

/**
 * CapabilityExecutionAdapter: Stage 9A.
 *
 * The single, typed bridge between a Skill Runtime capability decision (routed through
 * TravelDecisionAdapter) and Travel Runtime execution. It:
 *   - inspects a TravelDecisionRoute's readiness capability
 *   - determines which existing Travel Runtime execution path handles it
 *   - invokes that path only where it is a pure, side-effect-free function (budget estimation) —
 *     everything else is described/prepared, never executed here
 *   - never calculates a budget, generates an itinerary, searches flights, calls a CRM, performs a
 *     booking, or (re-)validates/merges Skill state — those responsibilities stay exactly where they
 *     already live (travel.runtime.ts, the tool-execution pipeline, the AI provider)
 *
 * Never throws: any failure is caught, logged as structured diagnostics, and returned as a FAILED
 * ExecutionDecision so the caller can fall back to the legacy Travel Runtime path exactly once, without
 * retrying or duplicating execution.
 */
@Injectable()
export class CapabilityExecutionAdapter {
  private readonly logger = new Logger(CapabilityExecutionAdapter.name);

  private readonly estimateBudget: BudgetEstimationFn;
  private readonly describeItineraryDelegation: ItineraryDelegationFn;
  private readonly prepareLiveSearch: LiveSearchPreparationFn;

  constructor(
    @Optional() estimateBudget?: BudgetEstimationFn,
    @Optional() describeItineraryDelegation?: ItineraryDelegationFn,
    @Optional() prepareLiveSearch?: LiveSearchPreparationFn
  ) {
    this.estimateBudget = estimateBudget ?? estimateBudgetRange;
    this.describeItineraryDelegation = describeItineraryDelegation ?? defaultItineraryDelegation;
    this.prepareLiveSearch = prepareLiveSearch ?? defaultLiveSearchPreparation;
  }

  execute(route: TravelDecisionRoute, context: CapabilityExecutionContext): ExecutionDecision {
    try {
      switch (route.action) {
        case "GENERATE_ITINERARY":
          return this.executeItinerary(context);
        case "ESTIMATE_BUDGET":
          return this.executeEstimate(context);
        case "SEARCH_LIVE":
          return this.executeLiveSearch(context);
        case "BOOKING_WORKFLOW_PENDING":
          return this.deferBooking();
        default:
          return notApplicableDecision();
      }
    } catch (error) {
      this.logger.error({
        event: "CAPABILITY_EXECUTION_FAILED",
        action: route.action,
        error: error instanceof Error ? error.message : "unknown"
      });
      return {
        capability: capabilityForAction(route.action),
        executionStatus: "FAILED",
        executionType: "NONE",
        executionTarget: null,
        requiresWorkflow: false,
        requiresHumanApproval: false,
        metadata: { error: error instanceof Error ? error.message : "unknown" }
      };
    }
  }

  private executeItinerary(context: CapabilityExecutionContext): ExecutionDecision {
    const { target, reason } = this.describeItineraryDelegation(context);
    return {
      capability: "ITINERARY",
      executionStatus: "DELEGATED",
      executionType: "LLM_ORCHESTRATED",
      executionTarget: target,
      requiresWorkflow: false,
      requiresHumanApproval: false,
      metadata: { reason }
    };
  }

  private executeEstimate(context: CapabilityExecutionContext): ExecutionDecision {
    const estimate = this.estimateBudget(
      context.entities,
      context.config,
      context.displayCurrency ?? undefined
    );
    return {
      capability: "ESTIMATE",
      executionStatus: "EXECUTED",
      executionType: "DETERMINISTIC_CALCULATION",
      executionTarget: "estimateBudgetRange",
      requiresWorkflow: false,
      requiresHumanApproval: false,
      metadata: { estimate }
    };
  }

  private executeLiveSearch(context: CapabilityExecutionContext): ExecutionDecision {
    const prepared = this.prepareLiveSearch(context);
    return {
      capability: "LIVE_SEARCH",
      executionStatus: "PREPARED",
      executionType: "TOOL_DELEGATED",
      executionTarget: prepared.target,
      requiresWorkflow: false,
      requiresHumanApproval: false,
      metadata: {
        tools: prepared.tools,
        destination: prepared.destination,
        travelMonth: prepared.travelMonth
      }
    };
  }

  private deferBooking(): ExecutionDecision {
    return {
      capability: "BOOKING",
      executionStatus: "DEFERRED",
      executionType: "WORKFLOW_PENDING",
      executionTarget: null,
      requiresWorkflow: true,
      requiresHumanApproval: false,
      metadata: { bookingSupported: false, workflowRequired: true }
    };
  }
}

function notApplicableDecision(): ExecutionDecision {
  return {
    capability: "NOT_APPLICABLE",
    executionStatus: "NOT_APPLICABLE",
    executionType: "NONE",
    executionTarget: null,
    requiresWorkflow: false,
    requiresHumanApproval: false,
    metadata: {}
  };
}

function capabilityForAction(action: TravelDecisionRoute["action"]): ExecutionDecision["capability"] {
  if (action === "GENERATE_ITINERARY") return "ITINERARY";
  if (action === "ESTIMATE_BUDGET") return "ESTIMATE";
  if (action === "SEARCH_LIVE") return "LIVE_SEARCH";
  if (action === "BOOKING_WORKFLOW_PENDING") return "BOOKING";
  return "NOT_APPLICABLE";
}

/**
 * Itinerary generation requires a live, per-conversation AI provider (see
 * TravelEmployeeLlmOrchestrator.safeGenerateItinerary) that this stateless adapter does not own — it is
 * described here, not performed, so Travel Runtime's existing orchestration remains the sole executor.
 */
function defaultItineraryDelegation(): { target: string; reason: string } {
  return {
    target: "TravelEmployeeLlmOrchestrator.itinerary",
    reason:
      "Itinerary generation requires a live, per-conversation AI provider; handled by Travel Runtime's existing orchestration."
  };
}

/**
 * Live search readiness only — the actual flight/hotel search stays behind the existing, tracked
 * tool-execution pipeline (travel.search_flights / travel.search_hotels) so it is never invoked twice.
 */
function defaultLiveSearchPreparation(
  context: CapabilityExecutionContext
): { target: string; tools: string[]; destination: string | null; travelMonth: string | null } {
  return {
    target: "travel.liveSearch",
    tools: ["travel.search_flights", "travel.search_hotels"],
    destination: context.entities.destinationCity,
    travelMonth: context.entities.travelMonth
  };
}
