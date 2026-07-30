import { Injectable, Logger } from "@nestjs/common";
import type { TravelLead, WorkflowExecution } from "@prisma/client";
import { isAffirmativeResponse } from "../../conversation/conversation-completion";
import {
  classifyPlanningAction,
  detectProviderFailureRecoverySelection,
  isRecoveryMenuActive
} from "../../travel/travel.runtime";
import { TravelLeadService } from "../../travel/travel-lead.service";
import {
  WorkflowExecutionRevisionConflictError,
  WorkflowExecutionService
} from "../workflow-execution.service";
import type { WorkflowExecutionScope, WorkflowTurnResult } from "../workflow-runtime.contracts";
import {
  CONTACT_CAPTURE_STEP_COLLECT_MOBILE_NUMBER,
  CONTACT_CAPTURE_STEP_COMPLETED,
  emptyContactCaptureState,
  nextContactCaptureField,
  type ContactCaptureStartSignals,
  type ContactCaptureState,
  type ContactCaptureTripContext
} from "./contact-capture.types";
import { extractIndianMobileNumber } from "./phone-validation";

const CONTACT_CAPTURE_TRIGGER_PATTERN =
  /\bcontact\s+me\b|\bspeak\s+(?:to|with)\s+(?:an?\s+)?advis(?:or|er)\b|\btalk\s+(?:to|with)\s+(?:an?\s+)?advis(?:or|er)\b|^\s*callback\s*$|^\s*call\s*back\s*$/i;

const MOBILE_NUMBER_QUESTION = "May I have your mobile number so a travel advisor can call you back?";
const INVALID_MOBILE_NUMBER_QUESTION =
  "That doesn't look like a valid 10-digit Indian mobile number. Could you share a valid mobile number?";
const SAFE_RETRY_MESSAGE =
  "Something went wrong saving your request just now. Please try again in a moment — you don't need to repeat your trip details.";

export interface ContactCaptureResumeResult extends WorkflowTurnResult<ContactCaptureState> {
  /** Non-null only the turn the internal lead was actually (freshly) created — never set on an
   *  idempotent replay, so the caller (AgentService) never fires a duplicate CRM sync attempt. */
  leadCreated: TravelLead | null;
}

/**
 * ContactCaptureWorkflowService: Stage 9B's first Pending Workflow Runtime workflow.
 *
 * Deterministic, non-LLM-driven — once started, it owns every subsequent turn until COMPLETED/FAILED/
 * CANCELLED, bypassing intent classification, RAG, and Skill Runtime capability routing entirely (see
 * AgentService.execute's workflow-first routing). It never re-implements lead persistence or CRM sync —
 * it calls the existing TravelLeadService.createInternalLead directly and hands the created lead back to
 * the caller, which performs the existing best-effort CRM mirror exactly as the `travel.create_lead`
 * tool already does.
 */
@Injectable()
export class ContactCaptureWorkflowService {
  private readonly logger = new Logger(ContactCaptureWorkflowService.name);

  constructor(
    private readonly workflows: WorkflowExecutionService,
    private readonly travelLeadService: TravelLeadService
  ) {}

  /**
   * Whether this turn should start (or resume, via the recovery menu) Contact Capture. Reuses existing
   * Travel Runtime signals rather than reinventing lead/callback-intent detection — every check here is
   * either an existing exported classifier/predicate or a field already present on the persisted
   * TravelConversationMemory the caller loaded this turn:
   *  - `classifyPlanningAction`: explicit "request a callback"/"create a lead"/"submit enquiry" phrasing
   *    (was the deterministic engine's REQUEST_CALLBACK_PATTERN/SUBMIT_ENQUIRY_PATTERN/CREATE_LEAD_PATTERN
   *    branch, and the LLM orchestrator's identical `classifyPlanningAction` branch).
   *  - recovery-menu "3"/CALLBACK selection (was `provider_failure_callback`).
   *  - `completionStage === "OFFERED"` + an affirmative reply (was the `OFFERED`→`AWAITING_CONTACT`
   *    transition on a proactive completion offer — `buildCompletionOfferMessage` itself asks "so one of
   *    our travel experts can contact you", the same advisor-callback semantic Contact Capture owns).
   *  - the explicit phrase set this stage adds ("contact me", "speak to an advisor", a standalone
   *    "callback") that none of Travel Runtime's own patterns covered.
   *
   * Deliberately NOT widened to cover `itineraryAlreadyPresented && isBookingConfirmation`
   * (`confirm_booking_lead_capture`) or a bare volunteered phone number (`CONFIRM_STANDALONE_CONTACT_USE`):
   * both are a genuinely different completion semantic — submitting/confirming the trip request itself,
   * with its own response wording and `TravelStage` tracking (see travel.e2e.spec.ts /
   * travel.contact-routing.e2e.spec.ts) — not an advisor-callback request. Retired/ported only once a
   * future stage gives that flow its own typed workflow; see the Stage 9C report's dependency map.
   */
  shouldStart(text: string, signals: ContactCaptureStartSignals): boolean {
    const planningAction = classifyPlanningAction(text);
    if (planningAction === "REQUEST_CALLBACK" || planningAction === "CREATE_LEAD" || planningAction === "SUBMIT_ENQUIRY")
      return true;
    if (isRecoveryMenuActive(signals.providerFailure) && detectProviderFailureRecoverySelection(text) === "CALLBACK")
      return true;
    if (signals.completionStage === "OFFERED" && isAffirmativeResponse(text)) return true;
    return CONTACT_CAPTURE_TRIGGER_PATTERN.test(text);
  }

  /** Starts a new CONTACT_CAPTURE workflow and asks for the one field it needs first. */
  async start(
    scope: WorkflowExecutionScope,
    turnId: string
  ): Promise<WorkflowTurnResult<ContactCaptureState>> {
    const state = emptyContactCaptureState();
    const mutation = await this.workflows.createWorkflow({
      scope,
      currentStep: CONTACT_CAPTURE_STEP_COLLECT_MOBILE_NUMBER,
      pendingInput: "MOBILE_NUMBER",
      state: state as unknown as Record<string, unknown>,
      turnId
    });
    return {
      decision: "ASK_FOR_INPUT",
      responseText: MOBILE_NUMBER_QUESTION,
      status: mutation.execution.status as WorkflowStatusLiteral,
      currentStep: mutation.execution.currentStep,
      pendingInput: mutation.execution.pendingInput,
      state
    };
  }

  /**
   * Resumes an active CONTACT_CAPTURE workflow with the current turn's text. Never throws: any
   * persistence/lead-creation failure is caught, logged without exposing contact data, and returned as a
   * safe retry decision so the caller falls back gracefully instead of routing elsewhere.
   */
  async resume(
    execution: WorkflowExecution,
    text: string,
    turnId: string,
    tripContext: ContactCaptureTripContext
  ): Promise<ContactCaptureResumeResult> {
    const state = execution.state as unknown as ContactCaptureState;

    // Stage 4.4 Phase 2: when a provider-verified WhatsApp number is available, use it directly
    // without asking "May I have your mobile number?".
    if (tripContext.verifiedPhoneNumber && !state.mobileNumber) {
      const phone = { valid: true as const, normalized: tripContext.verifiedPhoneNumber };
      return this.completeWithPhone(execution, phone, turnId, tripContext, state);
    }

    if (execution.pendingInput === "MOBILE_NUMBER" || nextContactCaptureField(state) === "MOBILE_NUMBER") {
      const phone = extractIndianMobileNumber(text);
      if (!phone.valid || !phone.normalized) {
        // Remain WAITING_FOR_INPUT — never persist an invalid attempt, so trip/workflow state is
        // untouched and a genuine retry of the same (still invalid) text behaves identically.
        return {
          decision: "ASK_FOR_INPUT",
          responseText: INVALID_MOBILE_NUMBER_QUESTION,
          status: "WAITING_FOR_INPUT",
          currentStep: execution.currentStep,
          pendingInput: "MOBILE_NUMBER",
          state,
          leadCreated: null
        };
      }

      const updatedState: ContactCaptureState = {
        ...state,
        mobileNumber: phone.normalized,
        preferredContactMethod: "PHONE",
        consentGiven: true,
        journeyId: state.journeyId ?? tripContext.journeyId,
        fullName: state.fullName ?? tripContext.customerName
      };
      const remainingField = nextContactCaptureField(updatedState);

      try {
        // Phase 1: persist the validated number and record this turnId BEFORE any external side
        // effect — a duplicate delivery of the exact same turn short-circuits here (idempotentReplay)
        // and never reaches lead creation a second time.
        const mutation = await this.workflows.updateWorkflowState({
          organizationId: execution.organizationId,
          id: execution.id,
          expectedRevision: execution.revision,
          currentStep:
            remainingField === "NONE" ? CONTACT_CAPTURE_STEP_COMPLETED : CONTACT_CAPTURE_STEP_COLLECT_MOBILE_NUMBER,
          pendingInput: remainingField === "NONE" ? null : remainingField,
          state: updatedState as unknown as Record<string, unknown>,
          turnId
        });

        if (mutation.idempotentReplay) {
          const replayState = mutation.execution.state as unknown as ContactCaptureState;
          return {
            decision: replayState.leadId ? "COMPLETE" : "ASK_FOR_INPUT",
            responseText: replayState.leadId
              ? buildCallbackConfirmation(replayState.mobileNumber ?? phone.normalized, tripContext)
              : MOBILE_NUMBER_QUESTION,
            status: mutation.execution.status as WorkflowStatusLiteral,
            currentStep: mutation.execution.currentStep,
            pendingInput: mutation.execution.pendingInput,
            state: replayState,
            leadCreated: null
          };
        }

        if (remainingField !== "NONE") {
          return {
            decision: "ASK_FOR_INPUT",
            responseText: questionForField(remainingField),
            status: mutation.execution.status as WorkflowStatusLiteral,
            currentStep: mutation.execution.currentStep,
            pendingInput: mutation.execution.pendingInput,
            state: updatedState,
            leadCreated: null
          };
        }

        // Phase 2: every required field is present — create (or idempotently reuse) the internal lead
        // and mark the workflow COMPLETED. This is the only phase with an external side effect, and
        // Phase 1's turnId check above guarantees it never runs twice for the same turn.
        const lead = await this.travelLeadService.createInternalLead({
          organizationId: execution.organizationId,
          pluginInstallationId: execution.pluginInstallationId,
          conversationId: execution.conversationId,
          journeyId: updatedState.journeyId,
          customerName: updatedState.fullName,
          phoneNumber: updatedState.mobileNumber ?? phone.normalized,
          email: updatedState.email,
          departureCity: tripContext.originCity,
          destination: tripContext.destinationCity,
          travelDates: tripContext.travelDates,
          passengers: tripContext.passengers,
          tripPurpose: tripContext.tripPurpose,
          budgetAmount: tripContext.budgetAmount,
          budgetCurrency: tripContext.budgetCurrency,
          displayCurrency: tripContext.displayCurrency,
          conversationSummary: buildConversationSummary(tripContext)
        });

        const finalState: ContactCaptureState = {
          ...updatedState,
          leadId: lead.id,
          leadReference: lead.reference
        };

        const completed = await this.workflows.markCompleted({
          organizationId: execution.organizationId,
          id: mutation.execution.id,
          expectedRevision: mutation.execution.revision,
          state: finalState as unknown as Record<string, unknown>
        });

        return {
          decision: "COMPLETE",
          responseText: buildCallbackConfirmation(finalState.mobileNumber ?? phone.normalized, tripContext),
          status: completed.status as WorkflowStatusLiteral,
          currentStep: completed.currentStep,
          pendingInput: completed.pendingInput,
          state: finalState,
          leadCreated: lead
        };
      } catch (error) {
        if (error instanceof WorkflowExecutionRevisionConflictError) {
          // Another concurrent turn already advanced this workflow — never retry blindly here; the
          // caller falls back to a safe message rather than risking a second lead-creation attempt.
          this.logger.warn({ event: "CONTACT_CAPTURE_REVISION_CONFLICT", workflowId: execution.id });
        } else {
          this.logger.error({
            event: "CONTACT_CAPTURE_PERSISTENCE_FAILED",
            workflowId: execution.id,
            error: error instanceof Error ? error.message : "unknown"
          });
        }
        return {
          decision: "FAIL",
          responseText: SAFE_RETRY_MESSAGE,
          status: "WAITING_FOR_INPUT",
          currentStep: execution.currentStep,
          pendingInput: "MOBILE_NUMBER",
          state,
          leadCreated: null
        };
      }
    }

    return {
      decision: "NOT_APPLICABLE",
      responseText: null,
      status: execution.status as WorkflowStatusLiteral,
      currentStep: execution.currentStep,
      pendingInput: execution.pendingInput,
      state,
      leadCreated: null
    };
  }

  private async completeWithPhone(
    execution: WorkflowExecution,
    phone: { valid: true; normalized: string },
    turnId: string,
    tripContext: ContactCaptureTripContext,
    state: ContactCaptureState
  ): Promise<ContactCaptureResumeResult> {
    const updatedState: ContactCaptureState = {
      ...state, mobileNumber: phone.normalized, preferredContactMethod: "PHONE", consentGiven: true,
      journeyId: state.journeyId ?? tripContext.journeyId, fullName: state.fullName ?? tripContext.customerName
    };
    try {
      const mutation = await this.workflows.updateWorkflowState({
        organizationId: execution.organizationId, id: execution.id, expectedRevision: execution.revision,
        currentStep: CONTACT_CAPTURE_STEP_COMPLETED, pendingInput: null,
        state: updatedState as unknown as Record<string, unknown>, turnId
      });
      if (mutation.idempotentReplay) {
        const rs = mutation.execution.state as unknown as ContactCaptureState;
        return { decision: "COMPLETE", responseText: buildCallbackConfirmation(rs.mobileNumber ?? phone.normalized, tripContext), status: mutation.execution.status as WorkflowStatusLiteral, currentStep: mutation.execution.currentStep, pendingInput: mutation.execution.pendingInput, state: rs, leadCreated: null };
      }
      const lead = await this.travelLeadService.createInternalLead({
        organizationId: execution.organizationId, pluginInstallationId: execution.pluginInstallationId,
        conversationId: execution.conversationId, journeyId: updatedState.journeyId,
        customerName: updatedState.fullName, phoneNumber: updatedState.mobileNumber ?? phone.normalized,
        email: updatedState.email, departureCity: tripContext.originCity, destination: tripContext.destinationCity,
        travelDates: tripContext.travelDates, passengers: tripContext.passengers, tripPurpose: tripContext.tripPurpose,
        budgetAmount: tripContext.budgetAmount, budgetCurrency: tripContext.budgetCurrency,
        displayCurrency: tripContext.displayCurrency, conversationSummary: buildConversationSummary(tripContext)
      });
      const finalState: ContactCaptureState = { ...updatedState, leadId: lead.id, leadReference: lead.reference };
      await this.workflows.markCompleted({
        organizationId: execution.organizationId, id: mutation.execution.id, expectedRevision: mutation.execution.revision,
        state: finalState as unknown as Record<string, unknown>
      });
      return { decision: "COMPLETE", responseText: buildCallbackConfirmation(finalState.mobileNumber ?? phone.normalized, tripContext), status: "COMPLETED", currentStep: CONTACT_CAPTURE_STEP_COMPLETED, pendingInput: null, state: finalState, leadCreated: lead };
    } catch (error) {
      this.logger.error({ event: "CONTACT_CAPTURE_VERIFIED_PHONE_FAILED", workflowId: execution.id, error: error instanceof Error ? error.message : "unknown" });
      return { decision: "FAIL", responseText: SAFE_RETRY_MESSAGE, status: "WAITING_FOR_INPUT", currentStep: execution.currentStep, pendingInput: "MOBILE_NUMBER", state, leadCreated: null };
    }
  }
}

type WorkflowStatusLiteral = WorkflowTurnResult<ContactCaptureState>["status"];

function questionForField(field: "EMAIL" | "FULL_NAME" | "MOBILE_NUMBER" | "NONE"): string {
  if (field === "EMAIL") return "Could you also share an email address for your callback request?";
  if (field === "FULL_NAME") return "And what name should the travel advisor ask for?";
  return MOBILE_NUMBER_QUESTION;
}

function buildConversationSummary(tripContext: ContactCaptureTripContext): string {
  const route =
    tripContext.originCity && tripContext.destinationCity
      ? `${tripContext.originCity} to ${tripContext.destinationCity}`
      : (tripContext.destinationCity ?? "their trip");
  return `Callback requested for ${route} trip enquiry.`;
}

function buildCallbackConfirmation(mobileNumber: string, tripContext: ContactCaptureTripContext): string {
  const route =
    tripContext.originCity && tripContext.destinationCity
      ? `${tripContext.originCity} to ${tripContext.destinationCity} trip`
      : tripContext.destinationCity
        ? `${tripContext.destinationCity} trip`
        : "trip";
  return `Your callback request has been saved. A travel advisor can contact you on ${mobileNumber} regarding your ${route}.`;
}
