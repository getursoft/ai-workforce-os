import { Injectable } from "@nestjs/common";
import { AgentMemoryScope } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  TRAVEL_TRIP_STATE_MEMORY_KEY,
  memoryFromStoredState,
  resolvesBudgetOverrideQuestion,
  resolvesTicketDeliveryQuestion
} from "../travel/travel.runtime";

/**
 * Travel Booking Closure Pass — Phase 2: "An active handoff alone does NOT mean every message belongs to
 * that specialist. However, when the active specialist has a structured pending question and the incoming
 * message reasonably satisfies that question, the specialist owns that turn." This is the pluggable
 * mechanism that answers that question — one resolver per specialist that HAS a structured pending-input
 * concept today (only Travel, via its own `pendingAction`). A specialist with no resolver registered here
 * simply never short-circuits routing this way; ordinary active-handoff-precedence scoring still applies
 * unchanged (see receptionist-routing.service.ts).
 *
 * Deliberately NOT a global keyword hack: each resolver's `satisfies()` check is scoped to the SPECIFIC
 * pending-input type it reports, and reuses the SAME classifier function the specialist's own dispatch
 * chain uses to decide what to do with the reply (`resolvesTicketDeliveryQuestion`) — there is exactly one
 * definition of "does this answer the ticket-delivery question", never a second, drifting copy of it here.
 */
export interface SpecialistPendingInputResolver {
  /** Which specialist this resolver understands — matched against the active handoff's target plugin. */
  employeeSlug: string;
  /** Returns a non-null, opaque pending-input type name when the specialist is currently waiting on a
   *  structured answer for this conversation, or null if nothing is pending. Read-only. */
  resolvePendingInputType(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string
  ): Promise<string | null>;
  /** Whether `text` reasonably answers the named pending-input type. */
  satisfies(pendingInputType: string, text: string): boolean;
}

const TRAVEL_TICKET_CONTACT_PENDING_INPUT = "AWAITING_TICKET_CONTACT";
const TRAVEL_BUDGET_OVERRIDE_PENDING_INPUT = "AWAITING_BUDGET_OVERRIDE_CONFIRMATION";

@Injectable()
export class TravelPendingInputResolver implements SpecialistPendingInputResolver {
  readonly employeeSlug = "travel-employee";

  constructor(private readonly prisma: PrismaService) {}

  async resolvePendingInputType(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string
  ): Promise<string | null> {
    const row = await this.prisma.agentMemory.findFirst({
      where: {
        organizationId,
        pluginInstallationId,
        conversationId,
        scope: AgentMemoryScope.CONVERSATION,
        key: TRAVEL_TRIP_STATE_MEMORY_KEY,
        deletedAt: null
      },
      select: { value: true }
    });
    if (!row) return null;
    const memory = memoryFromStoredState(row.value as Record<string, unknown> | null);
    // Only the two pendingAction values proven to collide with another employee's own routing vocabulary
    // are wired up today: AWAITING_TICKET_CONTACT ("share it here" vs. IT Support's "it" domain keyword)
    // and AWAITING_BUDGET_OVERRIDE_CONFIRMATION ("yes, above my budget" vs. Finance's "budget" alias).
    // Other Travel pendingAction values (option selection, passenger details, booking confirmation, ...)
    // are deliberately left to the existing active-handoff-precedence scoring, which already handles them
    // safely in practice — this resolver is scoped to known, proven collisions, not a blanket "Travel
    // always wins" rule.
    if (memory.pendingAction === "AWAITING_TICKET_CONTACT") return TRAVEL_TICKET_CONTACT_PENDING_INPUT;
    if (memory.pendingAction === "AWAITING_BUDGET_OVERRIDE_CONFIRMATION") return TRAVEL_BUDGET_OVERRIDE_PENDING_INPUT;
    return null;
  }

  satisfies(pendingInputType: string, text: string): boolean {
    if (pendingInputType === TRAVEL_TICKET_CONTACT_PENDING_INPUT) return resolvesTicketDeliveryQuestion(text);
    if (pendingInputType === TRAVEL_BUDGET_OVERRIDE_PENDING_INPUT) return resolvesBudgetOverrideQuestion(text);
    return false;
  }
}

@Injectable()
export class SpecialistPendingInputRegistry {
  constructor(
    private readonly prisma: PrismaService,
    private readonly travel: TravelPendingInputResolver
  ) {}

  private resolvers(): SpecialistPendingInputResolver[] {
    return [this.travel];
  }

  /**
   * True when the active specialist (a plugin installation) currently has a structured pending question
   * AND `text` reasonably satisfies it — the ONLY thing that should let a turn bypass domain-switch scoring
   * entirely. False for every other case (no registered resolver for this specialist, no pending question,
   * or the message doesn't answer it) — those fall through to the existing routing precedence unchanged.
   * `targetConversationId` is the SPECIALIST's own conversation (not the Receptionist's) — null (no
   * specialist conversation started yet) always resolves to false.
   */
  async isSatisfiedBy(
    organizationId: string,
    targetEmployeeInstallationId: string,
    targetConversationId: string | null,
    text: string
  ): Promise<boolean> {
    if (!targetConversationId) return false;
    const resolvers = this.resolvers();
    if (!resolvers.length) return false;
    const plugin = await this.prisma.plugin.findUnique({
      where: { id: targetEmployeeInstallationId },
      select: { slug: true }
    });
    if (!plugin) return false;
    const resolver = resolvers.find((candidate) => candidate.employeeSlug === plugin.slug);
    if (!resolver) return false;
    const pendingInputType = await resolver.resolvePendingInputType(
      organizationId,
      targetEmployeeInstallationId,
      targetConversationId
    );
    if (!pendingInputType) return false;
    return resolver.satisfies(pendingInputType, text);
  }
}
