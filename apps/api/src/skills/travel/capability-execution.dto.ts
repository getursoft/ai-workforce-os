import type { BudgetEstimate, TravelEmployeeRuntimeConfig, TravelEntities } from "../../travel/travel.runtime";

/**
 * Stage 9A: Capability Execution Adapter typed contracts.
 *
 * The adapter translates a Skill Runtime capability-ready decision (via TravelDecisionRoute) into a
 * typed ExecutionDecision describing which existing Travel Runtime execution path handles it. It never
 * performs the underlying business logic itself — see CapabilityExecutionAdapter's doc comment.
 */

/** Which capability a route maps to. "NOT_APPLICABLE" covers non-capability routes (ASK_QUESTION, errors). */
export type ExecutionCapability = "ITINERARY" | "ESTIMATE" | "LIVE_SEARCH" | "BOOKING" | "NOT_APPLICABLE";

export type ExecutionStatus =
  /** The adapter invoked the existing, pure Travel Runtime function directly and holds a real result. */
  | "EXECUTED"
  /** The adapter confirmed readiness and assembled the invocation target; the existing tool-execution
   *  pipeline performs the actual call (never duplicated here). */
  | "PREPARED"
  /** The target execution requires resources the adapter does not own (e.g. a live, per-conversation AI
   *  provider) and is left to Travel Runtime's existing orchestration, unchanged. */
  | "DELEGATED"
  /** Capability intentionally not executed in this stage (booking workflow). */
  | "DEFERRED"
  /** Capability is ready to be executed (booking workflow ready). */
  | "EXECUTABLE"
  /** Execution/preparation failed; the caller must fall back to legacy Travel Runtime, never retry. */
  | "FAILED"
  /** The route is not a capability-execution route at all. */
  | "NOT_APPLICABLE";

export type ExecutionType =
  | "DETERMINISTIC_CALCULATION"
  | "LLM_ORCHESTRATED"
  | "TOOL_DELEGATED"
  | "WORKFLOW_PENDING"
  | "WORKFLOW_READY"
  | "NONE";

/** A typed, structured execution result — deliberately no free-form execution strings. */
export interface ExecutionDecision {
  capability: ExecutionCapability;
  executionStatus: ExecutionStatus;
  executionType: ExecutionType;
  /** Name of the existing Travel Runtime function/tool this maps to, or null when nothing executes. */
  executionTarget: string | null;
  requiresWorkflow: boolean;
  requiresHumanApproval: boolean;
  metadata: Record<string, unknown>;
}

export interface CapabilityExecutionContext {
  entities: TravelEntities;
  config: TravelEmployeeRuntimeConfig;
  displayCurrency?: string | null;
}

/** Collaborator: computes a real budget estimate via the existing estimation function. */
export type BudgetEstimationFn = (
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig,
  displayCurrency?: string
) => BudgetEstimate;

/** Collaborator: describes where itinerary generation is delegated to (never performs it). */
export type ItineraryDelegationFn = (context: CapabilityExecutionContext) => {
  target: string;
  reason: string;
};

/** Collaborator: assembles a readiness-only search descriptor (never performs the search itself). */
export type LiveSearchPreparationFn = (context: CapabilityExecutionContext) => {
  target: string;
  tools: string[];
  destination: string | null;
  travelMonth: string | null;
};
