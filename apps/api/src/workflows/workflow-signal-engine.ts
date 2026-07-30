import { Injectable } from "@nestjs/common";
import { ContactCaptureWorkflowService } from "./contact-capture/contact-capture.service";
import { TripSubmissionWorkflowService } from "./trip-submission/trip-submission.service";
import type { WorkflowDispatchSignals } from "./workflow-runtime.contracts";
import { noWorkflowSignal, type WorkflowSignal } from "./workflow-signal.contracts";

/**
 * Stage 9E: the Workflow Signal Engine — the ONLY place that evaluates "does this turn's free text want to
 * start a new workflow." `WorkflowCoordinator` no longer contains this evaluation itself (compare Stage
 * 9C/9D, where `dispatchTurn` called `contactCapture.shouldStart`/`tripSubmission.shouldStart` directly);
 * it only asks this engine for a signal, then resolves that signal through `WorkflowSignalRegistry`.
 *
 * `BOOKING_HANDOFF` never starts from free text (see `WorkflowCoordinator.startBookingHandoff`), so it is
 * not considered here — a typed `READY_FOR_BOOKING` capability decision constructs that signal directly.
 * The BELOW_MINIMUM-budget trigger for `START_TRIP_SUBMISSION` is also not evaluated here: Travel Runtime
 * itself emits that signal directly (see `travel.runtime.ts`'s `TravelRuntimeExecutionMode`), since it is
 * Travel Runtime's own business calculation, not a free-text pattern.
 */
@Injectable()
export class WorkflowSignalEngine {
  constructor(
    private readonly contactCapture: ContactCaptureWorkflowService,
    private readonly tripSubmission: TripSubmissionWorkflowService
  ) {}

  deriveSignal(text: string, signals: WorkflowDispatchSignals, turnId: string): WorkflowSignal {
    if (this.contactCapture.shouldStart(text, signals.contactCapture)) {
      return {
        signalType: "START_CONTACT_CAPTURE",
        workflowType: "CONTACT_CAPTURE",
        source: "CALLBACK_INTENT_PHRASE",
        sourceTurnId: turnId,
        sourceSkillExecutionId: null,
        payload: {},
        confidence: 1
      };
    }

    const tripSubmissionTrigger = this.tripSubmission.shouldStart(text, signals.tripSubmission);
    if (tripSubmissionTrigger !== "NONE") {
      return {
        signalType: "START_TRIP_SUBMISSION",
        workflowType: "TRIP_SUBMISSION",
        source:
          tripSubmissionTrigger === "STANDALONE_CONTACT"
            ? "STANDALONE_CONTACT_VOLUNTEERED"
            : "TRIP_SUBMISSION_CONFIRMATION",
        sourceTurnId: turnId,
        sourceSkillExecutionId: null,
        payload: { trigger: tripSubmissionTrigger },
        confidence: 1
      };
    }

    return noWorkflowSignal(turnId);
  }
}
