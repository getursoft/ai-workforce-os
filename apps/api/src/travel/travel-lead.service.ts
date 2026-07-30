import { Injectable, Logger } from "@nestjs/common";
import { Prisma, TravelLead, TravelLeadCrmSyncStatus } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { generateLeadReference } from "../conversation/conversation-completion";

/**
 * Everything needed to persist a {@link TravelLead}, from any Travel Employee execution path (LLM
 * `travel.create_lead`, deterministic `TravelEmployeeProvider`, below-minimum-budget handoff, callback
 * request, submit enquiry/request, escalation, or a resumed lead capture after another turn). Every one of
 * those paths funnels through {@link TravelLeadService.createInternalLead} — there is exactly one
 * persistence contract, never separate semantics per runtime.
 */
export interface CreateInternalLeadInput {
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  /** The in-memory multi-city Journey.id this lead belongs to, if any — null for a plain single-leg trip. */
  journeyId?: string | null;
  customerName?: string | null;
  phoneNumber: string;
  email?: string | null;
  departureCity?: string | null;
  /** The complete current route, including every multi-city leg — never just the active leg. */
  destination?: string | null;
  travelDates?: string | null;
  passengers?: string | null;
  tripPurpose?: string | null;
  budgetAmount?: number | null;
  budgetCurrency?: string | null;
  displayCurrency?: string | null;
  conversationSummary: string;
  /** Caller-supplied reference (kept in sync with a customer-facing confirmation message); a fresh one is
   * generated when omitted. */
  reference?: string | null;
}

/**
 * The single, always-on internal lead-persistence path for every Travel Employee execution path — see the
 * module doc on {@link CreateInternalLeadInput}. External CRM availability never determines whether this
 * succeeds: `AgentService` calls this FIRST, then attempts a best-effort CRM mirror afterward (see
 * `AgentService.syncLeadToCrmBestEffort`), never the other way around.
 */
@Injectable()
export class TravelLeadService {
  private readonly logger = new Logger(TravelLeadService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findCurrentLead(input: {
    organizationId: string;
    pluginInstallationId: string;
    conversationId: string;
    journeyId?: string | null;
  }): Promise<TravelLead | null> {
    const scope = {
      organizationId: input.organizationId,
      pluginInstallationId: input.pluginInstallationId,
      conversationId: input.conversationId,
      status: { not: "CLOSED" as const }
    };
    if (input.journeyId) {
      const journeyLead = await this.prisma.travelLead.findFirst({
        where: { ...scope, journeyId: input.journeyId },
        orderBy: { createdAt: "desc" }
      });
      if (journeyLead) return journeyLead;
    }
    return this.prisma.travelLead.findFirst({
      where: scope,
      orderBy: { createdAt: "desc" }
    });
  }

  /**
   * Tenant-scoped idempotency key: the SAME organization + conversation + journey (or "single" when there's
   * no multi-leg journey) always resolves to the same lead — a repeated "ji"/"haan", a repeated phone
   * number, or a duplicate runtime retry with the same inputs must never create a second row. A genuinely
   * new journey (a fresh `Journey.id`) always gets its own key, and therefore its own lead.
   */
  buildIdempotencyKey(organizationId: string, conversationId: string, journeyId?: string | null): string {
    return `${organizationId}:${conversationId}:${journeyId ?? "single"}:LEAD_CAPTURE`;
  }

  /**
   * Creates (or, idempotently, returns) the internal {@link TravelLead} for this conversation/journey.
   * Never requires every optional journey field — only `phoneNumber` and `conversationSummary` are
   * required, mirroring the `travel.create_lead` tool's own input contract. `consentGivenAt` is stamped
   * unconditionally at creation time: every caller of this method only ever calls it after consent and a
   * phone number were already collected, so consent is implicit in the row existing at all.
   */
  async createInternalLead(input: CreateInternalLeadInput): Promise<TravelLead> {
    const idempotencyKey = this.buildIdempotencyKey(input.organizationId, input.conversationId, input.journeyId);
    const existing = await this.prisma.travelLead.findUnique({ where: { idempotencyKey } });
    // Tenant isolation: even though the key already embeds organizationId (so a cross-tenant collision on
    // the string itself is not realistically possible), never trust a found row without also checking it —
    // a row must never be handed back to, or reused for, a different organization.
    if (existing && existing.organizationId === input.organizationId) return existing;

    const data = {
      organizationId: input.organizationId,
      pluginInstallationId: input.pluginInstallationId,
      conversationId: input.conversationId,
      journeyId: input.journeyId ?? null,
      customerName: input.customerName ?? null,
      phoneNumber: input.phoneNumber,
      email: input.email ?? null,
      departureCity: input.departureCity ?? null,
      destination: input.destination ?? null,
      travelDates: input.travelDates ?? null,
      passengers: input.passengers ?? null,
      tripPurpose: input.tripPurpose ?? null,
      budgetAmount: input.budgetAmount ?? null,
      budgetCurrency: input.budgetCurrency ?? null,
      displayCurrency: input.displayCurrency ?? null,
      conversationSummary: input.conversationSummary,
      consentGivenAt: new Date(),
      idempotencyKey,
      crmSyncStatus: TravelLeadCrmSyncStatus.PENDING
    };
    const reference = input.reference ?? generateLeadReference("TRV");
    try {
      return await this.prisma.travelLead.create({ data: { ...data, reference } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = error.meta?.target;
        const targetsIdempotencyKey = Array.isArray(target)
          ? target.includes("idempotency_key")
          : typeof target === "string" && target.includes("idempotency_key");
        if (targetsIdempotencyKey) {
          // Lost a race with a concurrent identical request (e.g. two rapid retries of the same runtime
          // turn) — the row that won the race is the source of truth, never create a second one.
          const winner = await this.prisma.travelLead.findUnique({ where: { idempotencyKey } });
          if (winner) return winner;
        }
        // A short random reference collided (see `generateLeadReference`) — extremely unlikely, but one
        // retry with a freshly generated reference is enough to clear it.
        return this.prisma.travelLead.create({ data: { ...data, reference: generateLeadReference("TRV") } });
      }
      throw error;
    }
  }

  /**
   * Records the outcome of the best-effort CRM mirror — purely observational, never awaited by, or allowed
   * to affect, the customer-facing turn. Swallows its own failure (e.g. the row was deleted concurrently)
   * rather than ever surfacing a secondary error from what is already a background, fire-and-forget path.
   */
  async markCrmSyncStatus(leadId: string, status: TravelLeadCrmSyncStatus): Promise<void> {
    try {
      await this.prisma.travelLead.update({ where: { id: leadId }, data: { crmSyncStatus: status } });
    } catch (error) {
      this.logger.warn({ event: "TRAVEL_LEAD_CRM_SYNC_STATUS_UPDATE_FAILED", leadId, status, error: String(error) });
    }
  }
}
