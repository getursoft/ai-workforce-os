import {
  Controller, Get, Post, Param, Body, Query, NotFoundException, Res, UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../../identity/presentation/http/permission.guard";
import { RequirePermission } from "../../identity/presentation/http/permission.decorators";
import { TravelBookingService } from "./travel-booking.service";
import { TravelCancellationService } from "../cancellation/travel-cancellation.service";
import { TicketGeneratorService } from "../delivery/ticket-generator.service";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

/**
 * Every route here is scoped to the CALLING principal's own organization (via `org(p)`), never a
 * client-supplied `?organizationId=` query param — a booking id alone is not proof of tenancy, so an
 * out-of-org id must 404 (via `getBooking`'s own `{id, organizationId}` filter), not 200 with another
 * org's data. Mirrors the `@UseGuards(JwtAccessGuard, PermissionGuard)` + `@RequirePermission` convention
 * already used by every other controller (see TravelEmployeeController, KnowledgeController).
 */
@ApiTags("Travel Bookings")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("travel")
export class TravelBookingController {
  constructor(
    private readonly bookingService: TravelBookingService,
    private readonly cancellationService: TravelCancellationService,
    private readonly ticketGenerator: TicketGeneratorService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("bookings")
  @RequirePermission("travel.booking.read")
  async listBookings(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const where: Record<string, unknown> = { organizationId: org(p) };
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      this.prisma.travelBooking.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        take: limit ? parseInt(limit, 10) : 50,
        skip: offset ? parseInt(offset, 10) : 0,
      }),
      this.prisma.travelBooking.count({ where: where as never }),
    ]);
    return { items, total };
  }

  @Get("bookings/:id")
  @RequirePermission("travel.booking.read")
  async getBooking(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const booking = await this.bookingService.getBooking(id, org(p));
    if (!booking) throw new NotFoundException("Booking not found");
    return booking;
  }

  @Get("bookings/:id/timeline")
  @RequirePermission("travel.booking.read")
  async getTimeline(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.bookingService.getBookingTimeline(id, org(p));
  }

  @Get("bookings/:id/ticket.pdf")
  @RequirePermission("travel.booking.read")
  async downloadTicket(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: { setHeader: (name: string, value: string) => void; send: (body: Buffer) => void },
  ) {
    const pdf = await this.ticketGenerator.generatePdfContent(id, org(p));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="ticket-${id.slice(0, 8)}.pdf"`);
    res.send(pdf);
  }

  @Post("bookings/:id/request-customer-approval")
  @RequirePermission("travel.booking.approve.customer")
  async requestCustomerApproval(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { snapshot: Record<string, unknown>; idempotencyKey?: string },
  ) {
    return this.bookingService.requestCustomerApproval(id, org(p), body.snapshot, body.idempotencyKey);
  }

  @Post("bookings/:id/customer-approve")
  @RequirePermission("travel.booking.manage")
  async customerApprove(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { customerId?: string; comment?: string },
  ) {
    return this.bookingService.recordCustomerDecision(id, org(p), "APPROVE", {
      actorExternalId: body.customerId ?? null,
      comment: body.comment ?? null,
      channel: "chat",
    });
  }

  @Post("bookings/:id/customer-reject")
  @RequirePermission("travel.booking.manage")
  async customerReject(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { customerId?: string; comment?: string },
  ) {
    return this.bookingService.recordCustomerDecision(id, org(p), "REJECT", {
      actorExternalId: body.customerId ?? null,
      comment: body.comment ?? null,
      channel: "chat",
    });
  }

  @Post("bookings/:id/submit-to-provider")
  @RequirePermission("travel.booking.manage")
  async submitToProvider(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    await this.bookingService.submitBookingToProvider(id, org(p));
    return { submitted: true };
  }

  @Post("bookings/:id/deliver-tickets")
  @RequirePermission("travel.booking.manage")
  async deliverTickets(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    await this.bookingService.deliverTickets(id, org(p));
    return { delivered: true };
  }

  @Post("bookings/:id/request-cancellation")
  @RequirePermission("travel.cancellation.request")
  async requestCancellation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { reason?: string; idempotencyKey?: string },
  ) {
    return this.cancellationService.requestCancellation(id, org(p), {
      reason: body.reason ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    } as never);
  }

  @Post("cancellations/:id/approve")
  @RequirePermission("travel.cancellation.approve")
  async approveCancellation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { comment?: string },
  ) {
    return this.cancellationService.recordManagerDecision(id, org(p), "APPROVE", {
      actorUserId: user(p),
      comment: body.comment ?? null,
    });
  }

  @Post("cancellations/:id/reject")
  @RequirePermission("travel.cancellation.approve")
  async rejectCancellation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { comment?: string },
  ) {
    return this.cancellationService.recordManagerDecision(id, org(p), "REJECT", {
      actorUserId: user(p),
      comment: body.comment ?? null,
    });
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
