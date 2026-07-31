import { Injectable, Logger } from "@nestjs/common";
import { WorkflowStatus, type WorkflowExecution } from "@prisma/client";
import {
  WorkflowExecutionRevisionConflictError,
  WorkflowExecutionService
} from "../workflow-execution.service";
import type { WorkflowExecutionScope, WorkflowTurnResult } from "../workflow-runtime.contracts";
import {
  BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
  BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
  BOOKING_HANDOFF_STEP_WAITING_FOR_CONFIRMATION,
  emptyBookingHandoffState,
  type BookingHandoffState,
  type BookingHandoffTripContext
} from "./booking-handoff.types";
import { isExplicitBookingConfirmation } from "./booking-confirmation";
import { ApprovalService } from "../../approval/approval.service";
import { TravelBookingService } from "../../travel/booking/travel-booking.service";

const SAFE_RETRY_MESSAGE =
  "Something went wrong saving your booking request just now. Please try again in a moment — you don't need to repeat your trip details.";

const APPROVAL_REQUESTED_MESSAGE =
  "Your booking request has been received and is waiting for approval. You'll be notified once a decision is made.";

type WorkflowStatusLiteral = WorkflowTurnResult<BookingHandoffState>["status"];

@Injectable()
export class BookingHandoffWorkflowService {
  private readonly logger = new Logger(BookingHandoffWorkflowService.name);

  constructor(
    private readonly workflows: WorkflowExecutionService,
    private readonly approvalService?: ApprovalService,
    private readonly bookingService?: TravelBookingService
  ) {}

  async start(
    scope: WorkflowExecutionScope,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state: BookingHandoffState = {
      ...emptyBookingHandoffState(),
      originCity: tripContext.originCity,
      destinationCity: tripContext.destinationCity,
      travelDates: tripContext.travelDates,
      skillExecutionId: tripContext.skillExecutionId,
      journeyId: tripContext.journeyId,
      selectedOption: tripContext.selectedOption ?? null
    };
    const mutation = await this.workflows.createWorkflow({
      scope,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_CONFIRMATION,
      pendingInput: "BOOKING_CONFIRMATION",
      state: state as unknown as Record<string, unknown>,
      turnId
    });

    // A selectedOption on the START signal means Travel Runtime's own turn already captured an explicit
    // "Confirm booking" reply (see travel.runtime.ts's AWAITING_BOOKING_CONFIRMATION routing — the signal
    // is only ever dispatched from inside `isExplicitBookingConfirmationReply(currentText) && selected`).
    // Starting at WAITING_FOR_CONFIRMATION and waiting for a SECOND explicit confirmation would silently
    // strand the booking, so the customer is never actually asked again. Proceed straight to requesting
    // approval instead. Since `confirmAndRequestApproval` auto-approves customer-confirmation bookings and
    // completes synchronously (see TravelBookingService.requestCustomerApproval), THIS call's own
    // `responseText` is what AgentService now uses to overwrite Travel Runtime's provisional "waiting for
    // approval" placeholder for this same turn — it is no longer discarded. `mutation.applied` guards
    // against the (defensive-only, since WorkflowCoordinator already checked no active workflow exists)
    // unique-conflict/replay case.
    if (tripContext.selectedOption && mutation.applied) {
      try {
        // A distinct suffixed turnId — `confirmAndRequestApproval`'s own `updateWorkflowState` call checks
        // turnId-based idempotency independently of `createWorkflow`'s above; reusing the SAME `turnId`
        // would make it look like this turn was already processed, silently skipping requestCustomerApproval.
        return await this.confirmAndRequestApproval(mutation.execution, `${turnId}:auto-confirm`, tripContext);
      } catch (error) {
        this.logger.error({
          event: "BOOKING_HANDOFF_PERSISTENCE_FAILED",
          workflowId: mutation.execution.id,
          error: error instanceof Error ? error.message : "unknown"
        });
        return {
          decision: "FAIL",
          responseText: SAFE_RETRY_MESSAGE,
          status: "WAITING_FOR_INPUT",
          currentStep: mutation.execution.currentStep,
          pendingInput: "BOOKING_CONFIRMATION",
          state: mutation.execution.state as unknown as BookingHandoffState
        };
      }
    }

    const resultState = mutation.execution.state as unknown as BookingHandoffState;
    return {
      decision: "ASK_FOR_INPUT",
      responseText: confirmationQuestion(tripContext),
      status: mutation.execution.status as WorkflowStatusLiteral,
      currentStep: mutation.execution.currentStep,
      pendingInput: mutation.execution.pendingInput,
      state: resultState
    };
  }

  async resume(
    execution: WorkflowExecution,
    text: string,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state = execution.state as unknown as BookingHandoffState;

    if (execution.status === "WAITING_FOR_APPROVAL" || execution.pendingInput === "APPROVED") {
      return this.handleApprovalResume(execution, state, tripContext);
    }

    if (execution.pendingInput !== "BOOKING_CONFIRMATION") {
      return {
        decision: "NOT_APPLICABLE",
        responseText: null,
        status: execution.status as WorkflowStatusLiteral,
        currentStep: execution.currentStep,
        pendingInput: execution.pendingInput,
        state
      };
    }

    if (!isExplicitBookingConfirmation(text)) {
      return {
        decision: "ASK_FOR_INPUT",
        responseText: confirmationQuestion(tripContext),
        status: "WAITING_FOR_INPUT",
        currentStep: execution.currentStep,
        pendingInput: "BOOKING_CONFIRMATION",
        state
      };
    }

    try {
      return await this.confirmAndRequestApproval(execution, turnId, tripContext);
    } catch (error) {
      if (error instanceof WorkflowExecutionRevisionConflictError) {
        this.logger.warn({ event: "BOOKING_HANDOFF_REVISION_CONFLICT", workflowId: execution.id });
      } else {
        this.logger.error({
          event: "BOOKING_HANDOFF_PERSISTENCE_FAILED",
          workflowId: execution.id,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
      return {
        decision: "FAIL",
        responseText: SAFE_RETRY_MESSAGE,
        status: "WAITING_FOR_INPUT",
        currentStep: execution.currentStep,
        pendingInput: "BOOKING_CONFIRMATION",
        state
      };
    }
  }

  private async handleApprovalResume(
    execution: WorkflowExecution,
    state: BookingHandoffState,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    if (state.approvalRequestId) {
      const approval = await this.approvalService?.findById(state.approvalRequestId, execution.organizationId);
      if (approval?.status === "APPROVED") {
        let bookingSummary = { bookingRef: null as string | null, pnr: null as string | null, ticketCount: 0 };

        if (state.bookingId && this.bookingService) {
          try {
            bookingSummary = await this.bookingService.confirmApprovalAndBook(
              state.bookingId,
              execution.organizationId
            );
            this.logger.log({
              event: "BOOKING_EXECUTED_AFTER_APPROVAL",
              bookingId: state.bookingId,
              bookingRef: bookingSummary.bookingRef,
              pnr: bookingSummary.pnr,
              ticketCount: bookingSummary.ticketCount
            });
          } catch (error) {
            this.logger.error({
              event: "BOOKING_EXECUTION_FAILED_AFTER_APPROVAL",
              bookingId: state.bookingId,
              error: error instanceof Error ? error.message : "unknown"
            });
          }
        }

        const confirmedState: BookingHandoffState = {
          ...state,
          confirmed: true,
          readyForFutureWorkflow: true,
          ticketReady: bookingSummary.pnr !== null
        };
        const mutation = await this.workflows.updateWorkflowState({
          organizationId: execution.organizationId,
          id: execution.id,
          expectedRevision: execution.revision,
          currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
          pendingInput: null,
          state: confirmedState as unknown as Record<string, unknown>,
          turnId: `${execution.id}:approval-resume`
        });
        const completed = await this.workflows.markCompleted({
          organizationId: execution.organizationId,
          id: mutation.execution.id,
          expectedRevision: mutation.execution.revision,
          state: confirmedState as unknown as Record<string, unknown>
        });

        const responseText = buildBookingConfirmedText(bookingSummary, tripContext);

        return {
          decision: "COMPLETE",
          responseText,
          status: completed.status as WorkflowStatusLiteral,
          currentStep: completed.currentStep,
          pendingInput: completed.pendingInput,
          state: confirmedState
        };
      }
      if (approval?.status === "REJECTED") {
        if (state.bookingId && this.bookingService) {
          try {
            await this.bookingService.markRejectedAfterApprovalDecision(state.bookingId, execution.organizationId);
          } catch (error) {
            this.logger.error({
              event: "BOOKING_REJECTION_STATUS_UPDATE_FAILED",
              bookingId: state.bookingId,
              error: error instanceof Error ? error.message : "unknown"
            });
          }
        }
        await this.workflows.markCancelled({
          organizationId: execution.organizationId,
          id: execution.id,
          expectedRevision: execution.revision,
          state: execution.state as Record<string, unknown>,
          currentStep: "CANCELLED"
        });
        return {
          decision: "CANCELLED",
          responseText: "Your booking request was not approved.",
          status: "CANCELLED",
          currentStep: "CANCELLED",
          pendingInput: null,
          state
        };
      }
    }
    return {
      decision: "ASK_FOR_INPUT",
      responseText: APPROVAL_REQUESTED_MESSAGE,
      status: "WAITING_FOR_APPROVAL",
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state
    };
  }

  private async confirmAndRequestApproval(
    execution: WorkflowExecution,
    turnId: string,
    tripContext: BookingHandoffTripContext
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const state = execution.state as unknown as BookingHandoffState;

    if (!this.approvalService) {
      return this.confirmAndCompleteLegacy(execution, turnId, tripContext, state);
    }

    const selectedOption = state.selectedOption ?? tripContext.selectedOption ?? null;

    let bookingId: string | null = null;
    if (this.bookingService) {
      try {
        const bookingInput: Record<string, unknown> = {
          organizationId: execution.organizationId,
          pluginInstallationId: execution.pluginInstallationId,
          conversationId: execution.conversationId ?? execution.id,
          workflowExecutionId: execution.id,
        };
        if (tripContext.originCity) bookingInput.originCity = tripContext.originCity;
        if (tripContext.destinationCity) bookingInput.destinationCity = tripContext.destinationCity;
        if (tripContext.travelDates) bookingInput.travelDates = tripContext.travelDates;
        if (typeof tripContext.travellerCount === "number") bookingInput.passengers = String(tripContext.travellerCount);
        if (tripContext.customerEmail) bookingInput.customerEmail = tripContext.customerEmail;
        if (tripContext.customerPhone) bookingInput.customerPhone = tripContext.customerPhone;
        const booking = await this.bookingService.create(bookingInput as never);
        bookingId = booking.id;

        // Every booking must pass through OPTIONS_PREPARED before WAITING_FOR_CUSTOMER_APPROVAL (see
        // TravelBookingService's VALID_TRANSITIONS — `create()` alone only ever leaves a booking in
        // DRAFT). Without this call, the next `requestCustomerApproval()` transition below always threw
        // (DRAFT -> WAITING_FOR_CUSTOMER_APPROVAL is not a valid transition), silently caught, leaving
        // every booking stuck in DRAFT forever and falling back to a booking-less generic approval. This
        // also persists the SPECIFIC selected package's flight/hotel/price snapshot onto the booking,
        // rather than leaving it empty.
        const flight = selectedOption?.flight as Record<string, unknown> | undefined;
        const hotel = selectedOption?.hotel as Record<string, unknown> | undefined;
        await this.bookingService.prepareOptions(bookingId, execution.organizationId, {
          flights: flight ? { segments: [flightSegmentFromOption(flight, tripContext)] } : {},
          hotels: hotel ?? {},
          itinerary: selectedOption ? { recommendationId: selectedOption.recommendationId, optionNumber: selectedOption.optionNumber } : {},
          ...(typeof selectedOption?.totalAmount === "number" ? { quotedAmount: selectedOption.totalAmount } : {}),
          ...(typeof selectedOption?.currency === "string" ? { quotedCurrency: selectedOption.currency } : {}),
          ...(tripContext.passengerDetails?.length ? { travellerSummary: { passengers: tripContext.passengerDetails } } : {})
        });
      } catch (error) {
        this.logger.error({
          event: "BOOKING_CREATION_FAILED",
          workflowId: execution.id,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }

    const mutation = await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: execution.id,
      expectedRevision: execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: { ...state, confirmed: true, bookingId } as unknown as Record<string, unknown>,
      turnId,
      status: WorkflowStatus.WAITING_FOR_APPROVAL
    });

    if (mutation.idempotentReplay) {
      return {
        decision: "REQUEST_APPROVAL",
        responseText: APPROVAL_REQUESTED_MESSAGE,
        status: "WAITING_FOR_APPROVAL",
        currentStep: mutation.execution.currentStep,
        pendingInput: mutation.execution.pendingInput,
        state: mutation.execution.state as unknown as BookingHandoffState
      };
    }

    let approvalRequestId: string | null = null;
    let autoApproved = false;
    if (bookingId && this.bookingService) {
      try {
        const result = await this.bookingService.requestCustomerApproval(
          bookingId,
          execution.organizationId,
          {}
        );
        approvalRequestId = result.approvalRequestId;
        autoApproved = result.autoApproved;
      } catch (error) {
        this.logger.error({
          event: "BOOKING_APPROVAL_REQUEST_FAILED",
          bookingId,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
    }

    // Customer-confirmation bookings (the default, no-custom-policy path — see
    // TravelBookingService.requestCustomerApproval) are already approved and booked by this point: finish
    // the workflow in this SAME turn instead of leaving the chat saying "waiting for approval" for
    // something that already happened.
    if (autoApproved && bookingId && this.bookingService) {
      let bookingSummary = { bookingRef: null as string | null, pnr: null as string | null, ticketCount: 0 };
      try {
        bookingSummary = await this.bookingService.confirmApprovalAndBook(bookingId, execution.organizationId);
      } catch (error) {
        this.logger.error({
          event: "BOOKING_EXECUTION_FAILED_AFTER_AUTO_APPROVAL",
          bookingId,
          error: error instanceof Error ? error.message : "unknown"
        });
      }
      const confirmedState: BookingHandoffState = {
        ...state,
        confirmed: true,
        bookingId,
        approvalRequestId,
        readyForFutureWorkflow: true,
        ticketReady: bookingSummary.pnr !== null
      };
      const readyMutation = await this.workflows.updateWorkflowState({
        organizationId: execution.organizationId,
        id: mutation.execution.id,
        expectedRevision: mutation.execution.revision,
        currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
        pendingInput: null,
        state: confirmedState as unknown as Record<string, unknown>,
        turnId: `${turnId}:auto-approved:${approvalRequestId}`
      });
      const completed = await this.workflows.markCompleted({
        organizationId: execution.organizationId,
        id: readyMutation.execution.id,
        expectedRevision: readyMutation.execution.revision,
        state: confirmedState as unknown as Record<string, unknown>
      });
      this.logger.log({
        event: "BOOKING_HANDOFF_AUTO_APPROVED_AND_BOOKED",
        workflowId: execution.id,
        bookingId,
        approvalRequestId,
        pnr: bookingSummary.pnr
      });
      return {
        decision: "COMPLETE",
        responseText: buildBookingConfirmedText(bookingSummary, tripContext),
        status: completed.status as WorkflowStatusLiteral,
        currentStep: completed.currentStep,
        pendingInput: completed.pendingInput,
        state: confirmedState
      };
    }

    if (!approvalRequestId) {
      const approval = await this.approvalService.create({
        organizationId: execution.organizationId,
        workflowExecutionId: execution.id,
        agentId: execution.pluginInstallationId,
        actionType: "BOOKING",
        requestedBy: tripContext.originCity ?? "travel-employee",
        title: `Booking approval for ${routeText(tripContext)}`,
        description: `A booking request for ${routeText(tripContext)} requires approval before proceeding.`,
        payload: {
          originCity: tripContext.originCity,
          destinationCity: tripContext.destinationCity,
          travelDates: tripContext.travelDates
        }
      });
      approvalRequestId = approval.id;
    }

    const approvalState: BookingHandoffState = {
      ...state,
      confirmed: true,
      bookingId,
      approvalRequestId
    };

    await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: mutation.execution.id,
      expectedRevision: mutation.execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: approvalState as unknown as Record<string, unknown>,
      turnId: `${turnId}:approval:${approvalRequestId}`,
      status: WorkflowStatus.WAITING_FOR_APPROVAL
    });

    this.logger.log({
      event: "BOOKING_HANDOFF_APPROVAL_REQUESTED",
      workflowId: execution.id,
      bookingId,
      approvalRequestId
    });

    return {
      decision: "REQUEST_APPROVAL",
      responseText: APPROVAL_REQUESTED_MESSAGE,
      status: "WAITING_FOR_APPROVAL",
      currentStep: BOOKING_HANDOFF_STEP_WAITING_FOR_APPROVAL,
      pendingInput: null,
      state: approvalState
    };
  }

  private async confirmAndCompleteLegacy(
    execution: WorkflowExecution,
    turnId: string,
    tripContext: BookingHandoffTripContext,
    state: BookingHandoffState
  ): Promise<WorkflowTurnResult<BookingHandoffState>> {
    const confirmedState: BookingHandoffState = { ...state, confirmed: true, readyForFutureWorkflow: true };
    const mutation = await this.workflows.updateWorkflowState({
      organizationId: execution.organizationId,
      id: execution.id,
      expectedRevision: execution.revision,
      currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW,
      pendingInput: null,
      state: confirmedState as unknown as Record<string, unknown>,
      turnId
    });
    if (mutation.idempotentReplay) {
      return {
        decision: "COMPLETE",
        responseText: buildHandoffConfirmation(tripContext),
        status: mutation.execution.status as WorkflowStatusLiteral,
        currentStep: mutation.execution.currentStep,
        pendingInput: mutation.execution.pendingInput,
        state: mutation.execution.state as unknown as BookingHandoffState
      };
    }
    const completed = await this.workflows.markCompleted({
      organizationId: execution.organizationId,
      id: mutation.execution.id,
      expectedRevision: mutation.execution.revision,
      state: confirmedState as unknown as Record<string, unknown>,
      currentStep: BOOKING_HANDOFF_STEP_READY_FOR_FUTURE_WORKFLOW
    });
    return {
      decision: "COMPLETE",
      responseText: buildHandoffConfirmation(tripContext),
      status: completed.status as WorkflowStatusLiteral,
      currentStep: completed.currentStep,
      pendingInput: completed.pendingInput,
      state: confirmedState
    };
  }
}

/** Maps a selected package's flight snapshot (travel-package-options.ts's `SimulatedFlightOption` shape)
 *  into the `{airline, flightNumber, departureCity, departureTime, arrivalCity, arrivalTime, cabin}`
 *  shape `TicketGeneratorService.generateTicketPackage()` already reads from `flightDetailsJson.segments`
 *  — reusing that existing, already-wired ticket-rendering path rather than inventing a second one. */
function flightSegmentFromOption(
  flight: Record<string, unknown>,
  tripContext: BookingHandoffTripContext
): Record<string, unknown> {
  return {
    airline: flight.carrierName ?? "Unknown",
    flightNumber: flight.flightNumber ?? "XX-000",
    departureCity: tripContext.originCity ?? "N/A",
    departureTime: flight.outboundDepartureTime ?? "N/A",
    arrivalCity: tripContext.destinationCity ?? "N/A",
    arrivalTime: flight.outboundArrivalTime ?? "N/A",
    cabin: flight.cabinClass ?? "Economy"
  };
}

function routeText(tripContext: BookingHandoffTripContext): string {
  if (tripContext.originCity && tripContext.destinationCity)
    return `${tripContext.originCity} to ${tripContext.destinationCity} trip`;
  if (tripContext.destinationCity) return `${tripContext.destinationCity} trip`;
  return "trip";
}

function confirmationQuestion(tripContext: BookingHandoffTripContext): string {
  const option = tripContext.selectedOption;
  if (option) {
    const total = option.totalAmount;
    const currency = option.currency;
    const flight = option.flight as Record<string, unknown> | undefined;
    const hotel = option.hotel as Record<string, unknown> | undefined;
    const lines = [
      "Please confirm your simulated booking:",
      "",
      routeText(tripContext),
      typeof tripContext.travelDates === "string" ? tripContext.travelDates : null,
      typeof tripContext.travellerCount === "number" ? `${tripContext.travellerCount} traveller(s)` : null,
      flight ? `Flight: ${String(flight.carrierName ?? "")} ${String(flight.flightNumber ?? "")}`.trim() : null,
      hotel ? `Hotel: ${String(hotel.hotelName ?? "")}` : null,
      typeof total === "number" && typeof currency === "string" ? `Total: ${currency} ${total}` : null,
      tripContext.vegetarianPreference ? "Food preference: Vegetarian" : null,
      "",
      "Reply 'Confirm booking' to proceed, or 'Change option' to choose another package."
    ].filter((line): line is string => line !== null);
    return lines.join("\n");
  }
  return `Would you like me to save a booking request for your ${routeText(tripContext)}? Shall I send it for confirmation?`;
}

function buildHandoffConfirmation(tripContext: BookingHandoffTripContext): string {
  return `Your booking request for the ${routeText(tripContext)} has been approved and saved.`;
}

/** Shared by the auto-approval path (confirmAndRequestApproval, same turn as "Confirm booking") and the
 *  manual-approval resume path (handleApprovalResume, a later turn) so both report the exact same wording
 *  once a booking is actually ticketed. */
function buildBookingConfirmedText(
  bookingSummary: { bookingRef: string | null; pnr: string | null; ticketCount: number },
  tripContext: BookingHandoffTripContext
): string {
  if (bookingSummary.pnr === null) return buildHandoffConfirmation(tripContext);
  return `Your booking is confirmed! PNR: ${bookingSummary.pnr}${bookingSummary.bookingRef ? `, Reference: ${bookingSummary.bookingRef}` : ""}. ${bookingSummary.ticketCount > 0 ? `${bookingSummary.ticketCount} ticket(s) have been generated.` : ""} This is a simulated booking in the AI Workforce OS demo environment.`;
}
