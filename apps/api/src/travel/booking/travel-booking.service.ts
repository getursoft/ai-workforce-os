import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";
import { ApprovalService } from "../../approval/approval.service";
import { ApprovalAuditService } from "../../approval/approval-audit.service";
import { BookingProviderAdapter } from "../provider/booking-provider-adapter";
import { TicketGeneratorService } from "../delivery/ticket-generator.service";
import { DeliveryRecorderService } from "../delivery/delivery-recorder.service";

export type TravelBookingStatus =
  | "DRAFT" | "OPTIONS_PREPARED" | "WAITING_FOR_CUSTOMER_APPROVAL"
  | "CUSTOMER_APPROVED" | "BOOKING_REQUEST_GENERATED" | "BOOKING_IN_PROGRESS"
  | "BOOKED" | "TICKETS_DELIVERED" | "CUSTOMER_REJECTED"
  | "CUSTOMER_REQUESTED_CHANGES" | "APPROVAL_EXPIRED" | "BOOKING_FAILED";

const VALID_TRANSITIONS: Record<string, TravelBookingStatus[]> = {
  DRAFT: ["OPTIONS_PREPARED"],
  OPTIONS_PREPARED: ["WAITING_FOR_CUSTOMER_APPROVAL", "CUSTOMER_REJECTED"],
  WAITING_FOR_CUSTOMER_APPROVAL: ["CUSTOMER_APPROVED", "CUSTOMER_REJECTED", "CUSTOMER_REQUESTED_CHANGES", "APPROVAL_EXPIRED"],
  CUSTOMER_APPROVED: ["BOOKING_REQUEST_GENERATED", "BOOKING_FAILED"],
  BOOKING_REQUEST_GENERATED: ["BOOKING_IN_PROGRESS", "BOOKING_FAILED"],
  BOOKING_IN_PROGRESS: ["BOOKED", "BOOKING_FAILED"],
  BOOKED: ["TICKETS_DELIVERED"],
  TICKETS_DELIVERED: [],
  CUSTOMER_REJECTED: [],
  CUSTOMER_REQUESTED_CHANGES: ["OPTIONS_PREPARED"],
  APPROVAL_EXPIRED: ["OPTIONS_PREPARED"],
  BOOKING_FAILED: ["OPTIONS_PREPARED"],
};

export interface CreateBookingInput {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  workflowExecutionId?: string;
  leadId?: string;
  originCity?: string;
  destinationCity?: string;
  travelDates?: string;
  passengers?: string;
  cabinClass?: string;
  budgetAmount?: number;
  budgetCurrency?: string;
  customerEmail?: string;
  customerPhone?: string;
  idempotencyKey?: string;
}

export interface BookingTimelineEntry {
  status: TravelBookingStatus;
  timestamp: string;
  actor?: string;
  detail?: string;
}

@Injectable()
export class TravelBookingService {
  private readonly logger = new Logger(TravelBookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvalService: ApprovalService,
    private readonly auditService: ApprovalAuditService,
    private readonly provider: BookingProviderAdapter,
    private readonly ticketGenerator: TicketGeneratorService,
    private readonly deliveryRecorder: DeliveryRecorderService,
  ) {}

  async create(input: CreateBookingInput): Promise<{ id: string; status: string }> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.travelBooking.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return { id: existing.id, status: existing.status };
    }

    const record = await this.prisma.travelBooking.create({
      data: {
        organizationId: input.organizationId,
        pluginInstallationId: input.pluginInstallationId,
        conversationId: input.conversationId,
        workflowExecutionId: input.workflowExecutionId ?? null,
        leadId: input.leadId ?? null,
        status: "DRAFT",
        originCity: input.originCity ?? null,
        destinationCity: input.destinationCity ?? null,
        travelDates: input.travelDates ?? null,
        passengers: input.passengers ?? null,
        cabinClass: input.cabinClass ?? null,
        budgetAmount: input.budgetAmount ?? null,
        budgetCurrency: input.budgetCurrency ?? null,
        customerEmail: input.customerEmail ?? null,
        customerPhone: input.customerPhone ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    await this.recordTimeline(record.id, "DRAFT", "SYSTEM", "Booking created");
    return { id: record.id, status: record.status };
  }

  async prepareOptions(
    bookingId: string,
    organizationId: string,
    options: {
      flights?: unknown;
      hotels?: unknown;
      itinerary?: unknown;
      quotedAmount?: number;
      quotedCurrency?: string;
      /** Every traveller's name/age/gender (see travel-package-options.ts's `PassengerDetail`) — persisted
       *  as-is onto `travellerSummaryJson` so the ticket names real passengers, not "Passenger 1"/"Passenger 2"
       *  placeholders. Omitted (never an empty array) when the caller has no passenger data at all. */
      travellerSummary?: unknown;
    }
  ): Promise<void> {
    await this.transitionTo(bookingId, organizationId, "OPTIONS_PREPARED", {
      flightDetailsJson: (options.flights ?? {}) as object,
      hotelDetailsJson: (options.hotels ?? {}) as object,
      itineraryJson: (options.itinerary ?? {}) as object,
      quotedAmount: options.quotedAmount ?? null,
      quotedCurrency: options.quotedCurrency ?? null,
      ...(options.travellerSummary ? { travellerSummaryJson: options.travellerSummary as object } : {}),
    });
  }

  async requestCustomerApproval(
    bookingId: string,
    organizationId: string,
    snapshot: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<{ approvalRequestId: string; autoApproved: boolean }> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    await this.transitionTo(bookingId, organizationId, "WAITING_FOR_CUSTOMER_APPROVAL", {
      snapshotJson: snapshot as object,
    });

    const approval = await this.approvalService.create({
      organizationId,
      workflowExecutionId: booking.workflowExecutionId ?? bookingId,
      agentId: booking.pluginInstallationId,
      actionType: "BOOKING",
      subjectType: "TRAVEL_BOOKING",
      subjectId: bookingId,
      requesterType: "CUSTOMER",
      requestedBy: booking.customerEmail ?? booking.customerPhone ?? "customer",
      title: `Booking approval for ${booking.destinationCity ?? "trip"}`,
      description: `Please confirm your itinerary and approve the booking. Amount: ${booking.quotedAmount ?? "—"} ${booking.quotedCurrency ?? ""}`,
      payload: { bookingId, snapshot },
      policyResolution: {
        organizationId,
        workflowType: "TRAVEL",
        actionType: "BOOKING",
        metadata: { bookingId },
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    await this.prisma.travelBooking.update({
      where: { id: bookingId },
      data: { approvalRequestId: approval.id },
    });

    // CUSTOMER_CONFIRMATION mode (the default policy for a BOOKING with no custom ApprovalPolicy
    // configured — see ApprovalPolicyEngine.defaultPolicy) makes the customer their own approver. The
    // customer already gave that approval by advancing the chat to this point (an explicit "Confirm
    // booking" reply) — there is no separate customer-facing "approve" action they could ever take, so
    // leaving this PENDING would strand every such booking until an admin manually approved it via the
    // internal API. Auto-approving here immediately runs the same provider-submission + ticket-delivery
    // path a manual approval would (see submitBookingToProvider), so the PDF/PNR are ready before this
    // same chat turn's response is sent.
    let autoApproved = false;
    if (approval.approverType === "CUSTOMER") {
      await this.recordCustomerDecision(bookingId, organizationId, "APPROVE", {
        actorExternalId: booking.customerEmail ?? booking.customerPhone ?? null,
        comment: "Auto-approved — the customer already confirmed this booking in chat.",
        channel: "chat",
      });
      autoApproved = true;
    }

    return { approvalRequestId: approval.id, autoApproved };
  }

  async recordCustomerDecision(
    bookingId: string,
    organizationId: string,
    decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
    actorInfo: { actorExternalId: string | null; comment: string | null; channel: string }
  ): Promise<void> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status !== "WAITING_FOR_CUSTOMER_APPROVAL") {
      throw new BadRequestException(`Cannot decide on booking in status ${booking.status}`);
    }
    if (!booking.approvalRequestId) throw new BadRequestException("Booking has no associated approval request");

    await this.approvalService.recordDecision(booking.approvalRequestId, organizationId, decision as never, {
      actorType: "CUSTOMER",
      actorExternalId: actorInfo.actorExternalId,
      comment: actorInfo.comment,
      channel: actorInfo.channel ?? "chat",
    });

    if (decision === "APPROVE") {
      await this.transitionTo(bookingId, organizationId, "CUSTOMER_APPROVED", {
        approvedAmount: booking.quotedAmount,
        priceTolerance: booking.quotedAmount ? Number(booking.quotedAmount) * 0.05 : null,
      });
      await this.submitBookingToProvider(bookingId, organizationId);
    } else if (decision === "REJECT") {
      await this.transitionTo(bookingId, organizationId, "CUSTOMER_REJECTED");
    } else {
      await this.transitionTo(bookingId, organizationId, "CUSTOMER_REQUESTED_CHANGES");
    }
  }

  async confirmApprovalAndBook(bookingId: string, organizationId: string): Promise<{ bookingRef: string | null; pnr: string | null; ticketCount: number }> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    if (booking.status === "BOOKED" || booking.status === "TICKETS_DELIVERED") {
      return {
        bookingRef: booking.providerBookingRef,
        pnr: booking.providerPnr,
        ticketCount: Array.isArray(booking.ticketNumbersJson) ? (booking.ticketNumbersJson as string[]).length : 0,
      };
    }

    if (booking.status !== "WAITING_FOR_CUSTOMER_APPROVAL") {
      throw new BadRequestException(`Booking must be awaiting customer approval (status: ${booking.status})`);
    }

    await this.transitionTo(bookingId, organizationId, "CUSTOMER_APPROVED", {
      approvedAmount: booking.quotedAmount,
      priceTolerance: booking.quotedAmount ? Number(booking.quotedAmount) * 0.05 : null,
    });

    await this.submitBookingToProvider(bookingId, organizationId);

    const updated = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    return {
      bookingRef: updated?.providerBookingRef ?? null,
      pnr: updated?.providerPnr ?? null,
      ticketCount: Array.isArray(updated?.ticketNumbersJson) ? (updated.ticketNumbersJson as string[]).length : 0,
    };
  }

  /**
   * Counterpart to {@link confirmApprovalAndBook} for the rejected outcome — used by the chat-driven
   * BOOKING_HANDOFF workflow, whose approval decision is recorded through the generic ApprovalService
   * (not through `recordCustomerDecision`'s own `approvalService.recordDecision` call), so it must never
   * call `recordCustomerDecision` here — that would record the same decision a second time. Without this,
   * a manager rejecting a booking left the TravelBooking row stuck at WAITING_FOR_CUSTOMER_APPROVAL forever
   * — the chat correctly told the customer "not approved", but the booking never showed as rejected in the
   * bookings dashboard.
   */
  async markRejectedAfterApprovalDecision(bookingId: string, organizationId: string): Promise<void> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");
    if (booking.status === "CUSTOMER_REJECTED") return;
    if (booking.status !== "WAITING_FOR_CUSTOMER_APPROVAL") {
      throw new BadRequestException(`Booking must be awaiting customer approval (status: ${booking.status})`);
    }
    await this.transitionTo(bookingId, organizationId, "CUSTOMER_REJECTED");
  }

  async submitBookingToProvider(bookingId: string, organizationId: string): Promise<void> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    if (booking.status !== "CUSTOMER_APPROVED") {
      throw new BadRequestException(`Booking must be customer-approved before provider submission (status: ${booking.status})`);
    }

    await this.transitionTo(bookingId, organizationId, "BOOKING_REQUEST_GENERATED", {
      providerStatus: "SUBMITTING",
    });

    await this.transitionTo(bookingId, organizationId, "BOOKING_IN_PROGRESS");

    const request = {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      originCity: booking.originCity,
      destinationCity: booking.destinationCity,
      travelDates: booking.travelDates,
      passengers: booking.passengers,
      cabinClass: booking.cabinClass,
      budgetAmount: booking.budgetAmount ? Number(booking.budgetAmount) : null,
      budgetCurrency: booking.budgetCurrency,
      customerEmail: booking.customerEmail,
      customerPhone: booking.customerPhone,
      selectedOptions: Array.isArray(booking.selectedOptionsJson) ? booking.selectedOptionsJson as Record<string, unknown>[] : [],
      flightDetails: (booking.flightDetailsJson ?? {}) as Record<string, unknown>,
      hotelDetails: (booking.hotelDetailsJson ?? {}) as Record<string, unknown>,
      itinerary: (booking.itineraryJson ?? {}) as Record<string, unknown>,
      travellerSummary: (booking.travellerSummaryJson ?? {}) as Record<string, unknown>,
    };

    try {
      const result = await this.provider.book(request);
      const providerData: {
        providerBookingRef?: string;
        providerPnr?: string;
        ticketNumbers?: string[];
        providerResponse?: Record<string, unknown>;
      } = {
        ticketNumbers: result.ticketNumbers,
        providerResponse: result.providerResponse,
      };
      if (result.providerBookingRef) providerData.providerBookingRef = result.providerBookingRef;
      if (result.providerPnr) providerData.providerPnr = result.providerPnr;
      await this.handleBookingResult(bookingId, organizationId, result.success, providerData);

      if (result.success) {
        await this.deliverTickets(bookingId, organizationId);
      }
    } catch (error) {
      this.logger.error({ event: "PROVIDER_BOOKING_EXCEPTION", bookingId, error: error instanceof Error ? error.message : "unknown" });
      await this.handleBookingResult(bookingId, organizationId, false, {
        providerResponse: { error: error instanceof Error ? error.message : "Unknown provider error" },
      });
    }
  }

  async handleBookingResult(
    bookingId: string,
    organizationId: string,
    success: boolean,
    providerData: {
      providerBookingRef?: string;
      providerPnr?: string;
      ticketNumbers?: string[];
      providerResponse?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (success) {
      const ticketNumbers = providerData.ticketNumbers ?? [];
      await this.transitionTo(bookingId, organizationId, "BOOKED", {
        providerBookingRef: providerData.providerBookingRef ?? null,
        providerPnr: providerData.providerPnr ?? null,
        ticketNumbersJson: ticketNumbers as unknown as object,
        providerResponseJson: (providerData.providerResponse ?? {}) as object,
        providerStatus: "CONFIRMED",
      });
    } else {
      await this.transitionTo(bookingId, organizationId, "BOOKING_FAILED", {
        providerResponseJson: (providerData.providerResponse ?? {}) as object,
        providerStatus: "FAILED",
      });
    }
  }

  async deliverTickets(bookingId: string, organizationId: string): Promise<void> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId, status: "BOOKED" },
    });
    if (!booking) {
      this.logger.warn({ event: "TICKET_DELIVERY_SKIPPED", bookingId, reason: "Booking not in BOOKED status" });
      return;
    }

    await this.ticketGenerator.generateTicketPackage(bookingId, organizationId);
    await this.deliveryRecorder.recordTicketDelivery(bookingId, organizationId);

    this.logger.log({ event: "TICKETS_DELIVERED", bookingId });
  }

  async getBooking(bookingId: string, organizationId: string) {
    return this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
  }

  /**
   * Looks up an already-ticketed booking (BOOKED/TICKETS_DELIVERED — never a draft or pending one, which
   * has no ticket to resend) by the email the customer booked with, for the "can you resend my ticket?"
   * conversational flow. Email is the definitive match key (unique per booking in practice, always
   * collected before a ticket exists); `travelDate` narrows it further when the same email has multiple
   * ticketed bookings, but is never required to have an exact format — a raw ISO date is checked as a
   * substring of the free-text `travelDates` field. Never invents a match: returns null rather than
   * guessing when nothing lines up.
   */
  async findBookingForResend(
    organizationId: string,
    criteria: { email: string; travelDate: string | null }
  ) {
    const candidates = await this.prisma.travelBooking.findMany({
      where: {
        organizationId,
        customerEmail: { equals: criteria.email, mode: "insensitive" },
        status: { in: ["BOOKED", "TICKETS_DELIVERED"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (candidates.length === 0) return null;
    if (criteria.travelDate) {
      const dateMatch = candidates.find((candidate) => candidate.travelDates?.includes(criteria.travelDate as string));
      if (dateMatch) return dateMatch;
    }
    // No date given, or none of the candidates' travelDates matched it — fall back to the most recently
    // ticketed booking for this email rather than refusing outright, since a single email usually only
    // has one active trip at a time.
    return candidates[0];
  }

  /** Regenerates and resends the ticket for an already-ticketed booking — used by both the dashboard's
   *  manual "resend" action and the chat-driven resend-ticket tool. */
  async resendTicket(bookingId: string, organizationId: string) {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId, status: { in: ["BOOKED", "TICKETS_DELIVERED"] } },
    });
    if (!booking) throw new NotFoundException("Booking not found or not yet ticketed");
    return this.deliveryRecorder.recordTicketDelivery(bookingId, organizationId);
  }

  async getBookingTimeline(bookingId: string, organizationId: string): Promise<BookingTimelineEntry[]> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const timelineEvents = await this.prisma.approvalAuditEvent.findMany({
      where: {
        organizationId,
        workflowExecutionId: booking.workflowExecutionId ?? null,
      } as never,
      orderBy: { createdAt: "asc" } as never,
    });

    const timeline: BookingTimelineEntry[] = [
      { status: "DRAFT", timestamp: booking.createdAt.toISOString(), actor: "SYSTEM", detail: "Booking created" },
    ];

    const statusEvents: Record<string, string> = {
      BOOKING_DRAFT: "DRAFT",
      BOOKING_OPTIONS_PREPARED: "OPTIONS_PREPARED",
      BOOKING_WAITING_FOR_CUSTOMER_APPROVAL: "WAITING_FOR_CUSTOMER_APPROVAL",
      BOOKING_CUSTOMER_APPROVED: "CUSTOMER_APPROVED",
      BOOKING_BOOKING_REQUEST_GENERATED: "BOOKING_REQUEST_GENERATED",
      BOOKING_BOOKING_IN_PROGRESS: "BOOKING_IN_PROGRESS",
      BOOKING_BOOKED: "BOOKED",
      BOOKING_TICKETS_DELIVERED: "TICKETS_DELIVERED",
      BOOKING_BOOKING_FAILED: "BOOKING_FAILED",
    };

    for (const event of timelineEvents) {
      const mapped = statusEvents[event.eventType];
      if (mapped) {
        const metadata = event.metadataJson as Record<string, unknown> | null;
        timeline.push({
          status: mapped as TravelBookingStatus,
          timestamp: event.createdAt.toISOString(),
          actor: metadata?.actorType as string ?? event.actorType,
          detail: metadata?.detail as string ?? undefined,
        });
      }
    }

    const seen = new Set<string>();
    return timeline
      .filter((entry) => {
        if (seen.has(entry.status)) return false;
        seen.add(entry.status);
        return true;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  private async transitionTo(
    bookingId: string,
    organizationId: string,
    targetStatus: TravelBookingStatus,
    extraData?: Record<string, unknown>
  ): Promise<void> {
    const booking = await this.prisma.travelBooking.findFirst({
      where: { id: bookingId, organizationId },
    });
    if (!booking) throw new NotFoundException("Booking not found");

    const allowed = VALID_TRANSITIONS[booking.status];
    if (!allowed?.includes(targetStatus)) {
      throw new BadRequestException(`Cannot transition booking from ${booking.status} to ${targetStatus}`);
    }

    const updateData: Record<string, unknown> = { status: targetStatus, ...(extraData ?? {}) };
    if (targetStatus === "BOOKED" || targetStatus === "TICKETS_DELIVERED") {
      updateData.completedAt = new Date();
    }

    await this.prisma.travelBooking.update({
      where: { id: bookingId },
      data: updateData as never,
    });

    await this.auditService.record({
      organizationId,
      workflowExecutionId: booking.workflowExecutionId ?? null,
      eventType: `BOOKING_${targetStatus}`,
      actorType: "SYSTEM",
      metadata: { bookingId, previousStatus: booking.status, targetStatus },
    });
  }

  private async recordTimeline(
    bookingId: string,
    status: string,
    actor: string,
    detail?: string
  ): Promise<void> {
    await this.auditService.record({
      organizationId: "",
      workflowExecutionId: null,
      eventType: `BOOKING_${status}`,
      actorType: actor,
      metadata: { bookingId, detail, status },
    });
  }
}
