import type { WorkflowStartSource, WorkflowType } from "./workflow-runtime.contracts";

/**
 * Stage 9E: the Workflow Signal Engine's typed contract.
 *
 * A `WorkflowSignal` is what an upstream layer (Travel Runtime's own business calculations, or the free-
 * text evaluation `WorkflowSignalEngine` runs on behalf of each workflow type) emits to say "a workflow
 * should start" — never a free-form string, never something WorkflowCoordinator infers by re-parsing the
 * assistant's generated response text or a private `pendingInputAction` field. `WorkflowCoordinator` never
 * evaluates whether to start a workflow itself; it only resolves a signal against `WorkflowSignalRegistry`
 * and dispatches. Adding a new workflow type's start trigger means adding a new `WorkflowSignalType` member
 * and a registry/engine entry — it never requires changing `workflow-coordinator.ts`.
 */
export type WorkflowSignalType =
  | "NONE"
  | "START_CONTACT_CAPTURE"
  | "START_TRIP_SUBMISSION"
  | "START_BOOKING_HANDOFF";

export interface WorkflowSignal {
  signalType: WorkflowSignalType;
  /** Null iff `signalType === "NONE"`. */
  workflowType: WorkflowType | null;
  /** Null iff `signalType === "NONE"`. */
  source: WorkflowStartSource | null;
  sourceTurnId: string;
  sourceSkillExecutionId: string | null;
  /** Typed extras a specific signal handler needs beyond the generic shape (e.g. which trigger variant
   *  fired) — never business data re-derived by the handler; always already-computed values the emitter
   *  attaches. */
  payload: Record<string, unknown>;
  /** How confident the emitter is that this signal should fire, 0-1. Every current emitter is
   *  deterministic and sets 1; reserved for a future probabilistic/LLM-assisted signal source. */
  confidence: number;
}

/** The canonical "no signal fired this turn" value — a typed sentinel, matching this codebase's existing
 *  convention (e.g. `TripSubmissionStartTrigger`'s `"NONE"`) rather than `null`, so every signal-producing
 *  function has one non-nullable return type. */
export function noWorkflowSignal(sourceTurnId: string): WorkflowSignal {
  return {
    signalType: "NONE",
    workflowType: null,
    source: null,
    sourceTurnId,
    sourceSkillExecutionId: null,
    payload: {},
    confidence: 0
  };
}
