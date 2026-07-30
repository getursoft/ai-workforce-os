import { Injectable } from "@nestjs/common";
import type { PlanTripSkillState } from "./plan-trip.skill";
import {
  nextMissingPlanTripInput,
  planTripReadinessPolicy,
  PLAN_TRIP_POLICY_VERSION,
  PLAN_TRIP_SKILL_VERSION
} from "./plan-trip.skill";
import type {
  InputDecision,
  InputDecisionType,
  PendingInputCode,
  DecisionContext
} from "./input-decision.dto.js";

/**
 * InputDecisionService: Generates InputDecision from SkillExecution state.
 *
 * This is the authoritative source of truth for what input is needed.
 * Travel Runtime receives this and executes business logic accordingly.
 *
 * Stage 8: Skill Runtime becomes the authority.
 */
@Injectable()
export class InputDecisionService {
  /**
   * Generate an InputDecision from the current skill state.
   * This is called after skill evaluation to determine what the user should be asked.
   */
  generate(state: PlanTripSkillState, context: DecisionContext): InputDecision {
    const startTime = Date.now();

    try {
      // Determine what's missing and what the next question should be
      const nextMissing = nextMissingPlanTripInput(state);
      const policy = planTripReadinessPolicy(state);

      // Determine decision based on state completeness
      const decision = this.determineDecision(state, policy, nextMissing);

      return {
        decision,
        pendingInput: nextMissing,
        missingFields: policy.blockers,
        readinessCapabilities: policy.capabilities,
        policyWarnings: policy.policyWarnings,
        explanationCode: this.explainDecision(decision, state, policy, nextMissing),
        skillVersion: PLAN_TRIP_SKILL_VERSION,
        policyVersion: PLAN_TRIP_POLICY_VERSION,
        stateRevision: state.revision
      };
    } catch (error) {
      // Never fail the user request because of InputDecision
      return this.stateAwareErrorDecision(state, error);
    } finally {
      context.decisionTimeMs = Date.now() - startTime;
    }
  }

  /**
   * Build a generic error decision when there is no reliable state to fall back on
   * (e.g. the SkillExecution itself could not be loaded). Always routes to legacy fallback.
   */
  errorDecision(params: {
    code: string;
    message: string;
    severity: "WARNING" | "ERROR";
  }): InputDecision {
    return {
      decision: "ERROR_STATE_LOSS",
      pendingInput: null,
      missingFields: [],
      readinessCapabilities: {
        itinerary: false,
        estimate: false,
        liveSearch: false,
        booking: false
      },
      policyWarnings: [],
      explanationCode: `ERROR_${params.code}`,
      skillVersion: PLAN_TRIP_SKILL_VERSION,
      policyVersion: PLAN_TRIP_POLICY_VERSION,
      stateRevision: 0
    };
  }

  /**
   * Determine the InputDecisionType based on current state and policy.
   */
  private determineDecision(
    _state: PlanTripSkillState,
    policy: ReturnType<typeof planTripReadinessPolicy>,
    nextMissing: PendingInputCode
  ): InputDecisionType {
    // If there's a missing input field, we need to ask
    if (nextMissing !== null) {
      return "ASK_FOR_INPUT";
    }

    // No missing input, check what capabilities are ready
    // Note: These are NOT mutually exclusive. A state can be ready for multiple capabilities.
    // We return a single decision type based on priority:
    // - If ready for live search and booking: READY_FOR_BOOKING
    // - Else if ready for live search: READY_FOR_LIVE_SEARCH
    // - Else if ready for estimate/itinerary: READY_FOR_ESTIMATE or READY_FOR_ITINERARY
    // - Else: still collecting input

    if (policy.capabilities.booking) {
      return "READY_FOR_BOOKING";
    }

    if (policy.capabilities.liveSearch) {
      return "READY_FOR_LIVE_SEARCH";
    }

    if (policy.capabilities.estimate) {
      return "READY_FOR_ESTIMATE";
    }

    if (policy.capabilities.itinerary) {
      return "READY_FOR_ITINERARY";
    }

    return "ASK_FOR_INPUT";
  }

  /**
   * Generate an explanation code for diagnostics.
   */
  private explainDecision(
    decision: InputDecisionType,
    _state: PlanTripSkillState,
    policy: ReturnType<typeof planTripReadinessPolicy>,
    nextMissing: PendingInputCode
  ): string {
    if (decision === "ASK_FOR_INPUT") {
      switch (nextMissing) {
        case "ORIGIN":
          return "ASKING_FOR_ORIGIN";
        case "DESTINATION":
          return "ASKING_FOR_DESTINATION";
        case "DEPARTURE_DATE":
          return "ASKING_FOR_DEPARTURE_DATE";
        case "TRAVEL_YEAR":
          return "ASKING_FOR_TRAVEL_YEAR";
        case "TRAVELLERS":
          return "ASKING_FOR_TRAVELLER_COUNT";
        case "TRAVELLER_COMPOSITION":
          return "ASKING_FOR_TRAVELLER_COMPOSITION";
        case "DURATION":
          return "ASKING_FOR_DURATION";
        default:
          return "ASKING_FOR_INPUT_UNKNOWN_FIELD";
      }
    }

    if (decision === "READY_FOR_BOOKING") {
      return "ALL_DATA_PRESENT_FOR_BOOKING";
    }

    if (decision === "READY_FOR_LIVE_SEARCH") {
      // Check what's still missing for booking
      const missingForBooking = policy.blockers.filter(
        (b) => b === "MISSING_TRAVEL_YEAR" || b === "MISSING_TRAVELLER_COMPOSITION"
      );
      if (missingForBooking.length > 0) {
        return "EARLY_PLANNING_COMPLETE_LIVE_SEARCH_READY";
      }
      return "LIVE_SEARCH_READY";
    }

    if (decision === "READY_FOR_ESTIMATE") {
      return "EARLY_PLANNING_COMPLETE_ESTIMATE_READY";
    }

    if (decision === "READY_FOR_ITINERARY") {
      return "EARLY_PLANNING_COMPLETE_ITINERARY_READY";
    }

    if (decision === "ERROR_VALIDATION_FAILED") {
      return "VALIDATION_FAILED";
    }

    if (decision === "ERROR_STATE_LOSS") {
      return "STATE_LOSS";
    }

    return "UNKNOWN_DECISION";
  }

  /**
   * Generate error decision when InputDecision service fails, preserving whatever can
   * still be recomputed from the current state. Never let InputDecision failure block
   * the user request.
   */
  private stateAwareErrorDecision(state: PlanTripSkillState, error: unknown): InputDecision {
    const errorCode = error instanceof Error ? error.message : "UNKNOWN_ERROR";

    // Fall back to simple logic: if no next missing input, mark as ready
    const nextMissing = nextMissingPlanTripInput(state);
    const policy = planTripReadinessPolicy(state);

    return {
      decision: "ERROR_STATE_LOSS",
      pendingInput: nextMissing,
      missingFields: policy.blockers,
      readinessCapabilities: policy.capabilities,
      policyWarnings: policy.policyWarnings,
      explanationCode: `ERROR_${errorCode}`,
      skillVersion: PLAN_TRIP_SKILL_VERSION,
      policyVersion: PLAN_TRIP_POLICY_VERSION,
      stateRevision: state.revision
    };
  }
}
