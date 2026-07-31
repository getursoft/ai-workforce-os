import { Logger } from "@nestjs/common";
import type { InputDecision } from "./input-decision.dto";

export interface TravelDecisionRoute {
  action:
    | "ASK_QUESTION"
    | "GENERATE_ITINERARY"
    | "ESTIMATE_BUDGET"
    | "SEARCH_LIVE"
    | "BOOKING_WORKFLOW_PENDING"
    | "SKILL_ERROR"
    | "LEGACY_FALLBACK";
  inputDecision: InputDecision;
  questionBrief?: string;
  questionFull?: string;
  capabilityReady?: {
    itinerary: boolean;
    estimate: boolean;
    liveSearch: boolean;
    booking: boolean;
  };
  explanation: string;
}

/**
 * TravelDecisionAdapter converts InputDecision to Travel Runtime routing decisions.
 *
 * This adapter ensures that Travel Runtime follows InputDecision directives
 * without understanding Skill Runtime internals. It translates typed decisions
 * into action codes that the Travel Runtime can execute.
 *
 * The adapter is stateless and can be used as a utility or injectable service.
 */
export class TravelDecisionAdapter {
  private static readonly logger = new Logger(TravelDecisionAdapter.name);

  /**
   * Convert an InputDecision into a Travel Runtime action route.
   *
   * Returns a routing decision that tells Travel Runtime what to do next.
   * - ASK_QUESTION: Return a question to the user
   * - GENERATE_ITINERARY: Proceed to itinerary generation
   * - ESTIMATE_BUDGET: Proceed to budget estimation
   * - SEARCH_LIVE: Proceed to live search
   * - BOOKING_WORKFLOW_PENDING: Booking is not yet implemented in Stage 8B
   * - SKILL_ERROR: An error occurred in the Skill Runtime
   * - LEGACY_FALLBACK: Fall back to the legacy Travel Runtime path
   */
  static route(
    decision: InputDecision,
    questionBrief?: string,
    questionFull?: string
  ): TravelDecisionRoute {
    const { decision: decisionType, readinessCapabilities } = decision;

    // Map Skill Runtime decisions to Travel Runtime actions
    switch (decisionType) {
      case "ASK_FOR_INPUT": {
        const explanation =
          decision.missingFields.length > 0
            ? `Missing fields: ${decision.missingFields.join(", ")}`
            : "Collecting required information";

        return {
          action: "ASK_QUESTION",
          inputDecision: decision,
          questionBrief: questionBrief || "Could you help me with that?",
          questionFull: questionFull || "I need a bit more information to help you plan.",
          capabilityReady: readinessCapabilities,
          explanation
        };
      }

      case "READY_FOR_ITINERARY": {
        // Travel Runtime should proceed with itinerary generation
        // Only if this decision is reached, all required fields are present
        return {
          action: "GENERATE_ITINERARY",
          inputDecision: decision,
          capabilityReady: readinessCapabilities,
          explanation: "All required fields are present. Ready to generate itinerary."
        };
      }

      case "READY_FOR_ESTIMATE": {
        // Travel Runtime should proceed with budget estimation
        // Typically comes before itinerary in planning workflow
        return {
          action: "ESTIMATE_BUDGET",
          inputDecision: decision,
          capabilityReady: readinessCapabilities,
          explanation: "Ready to provide budget estimate based on current information."
        };
      }

      case "READY_FOR_LIVE_SEARCH": {
        // Travel Runtime should proceed to live provider search
        // Requires complete traveller composition and full year
        return {
          action: "SEARCH_LIVE",
          inputDecision: decision,
          capabilityReady: readinessCapabilities,
          explanation:
            "Ready to search live providers for flights and hotels with complete information."
        };
      }

      case "READY_FOR_BOOKING": {
        return {
          action: "BOOKING_WORKFLOW_PENDING",
          inputDecision: decision,
          capabilityReady: readinessCapabilities,
          explanation:
            "Your trip details are complete. I can help you book this trip — would you like to proceed with the booking? This will go through a simulated booking process with customer approval."
        };
      }

      case "ERROR_VALIDATION_FAILED": {
        // A validation error occurred in the Skill Runtime
        return {
          action: "SKILL_ERROR",
          inputDecision: decision,
          explanation: `Validation error: ${decision.explanationCode}`
        };
      }

      case "ERROR_STATE_LOSS": {
        // State was lost or corrupted; fall back to legacy path
        return {
          action: "LEGACY_FALLBACK",
          inputDecision: decision,
          explanation: `State error (${decision.explanationCode}); using legacy processing`
        };
      }

      default: {
        // Unknown decision type
        TravelDecisionAdapter.logger.error({
          event: "UNKNOWN_DECISION_TYPE",
          decisionType
        });
        return {
          action: "LEGACY_FALLBACK",
          inputDecision: decision,
          explanation: "Unknown decision type; falling back to legacy processing"
        };
      }
    }
  }

  /**
   * Check whether this decision requires Travel Runtime to execute a capability.
   */
  static requiresCapabilityExecution(
    route: TravelDecisionRoute
  ): route is TravelDecisionRoute & { action: "GENERATE_ITINERARY" | "ESTIMATE_BUDGET" | "SEARCH_LIVE" } {
    return ["GENERATE_ITINERARY", "ESTIMATE_BUDGET", "SEARCH_LIVE"].includes(route.action);
  }

  /**
   * Check whether this decision requires a question to be asked.
   */
  static requiresQuestion(route: TravelDecisionRoute): route is TravelDecisionRoute & { action: "ASK_QUESTION" } {
    return route.action === "ASK_QUESTION";
  }

  /**
   * Check whether this decision indicates a deferred action (booking not ready).
   */
  static isDeferredAction(route: TravelDecisionRoute): boolean {
    return route.action === "BOOKING_WORKFLOW_PENDING";
  }

  /**
   * Check whether this decision requires fallback to legacy processing.
   */
  static shouldFallback(route: TravelDecisionRoute): boolean {
    return route.action === "LEGACY_FALLBACK" || route.action === "SKILL_ERROR";
  }
}
