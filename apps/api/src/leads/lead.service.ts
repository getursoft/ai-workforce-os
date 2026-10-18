/**
 * Krevia CRM — the single, channel-agnostic Lead persistence path every AI Employee's capture flow
 * (Travel, Sales, ...; web chat, WhatsApp, voice) and every manual/API entry point funnel through. Mirrors
 * the same "internal row is always created first, external CRM is a best-effort optional mirror afterward"
 * contract TravelLeadService already established (see `apps/api/src/conversation/conversation-completion.ts`
 * and `TravelLeadService.createInternalLead`) — this service is the cross-vertical generalization of that
 * same idea, never a competing implementation.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import { Lead, LeadActivityType, LeadPriority, LeadSource, LeadStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { generateLeadReference } from "../conversation/conversation-completion";

const ACTIVE_STATUSES: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "FOLLOW_UP"];
const MAX_REFERENCE_ATTEMPTS = 5;

/** Everything a specialist AI Employee's own lead-capture path (e.g. TravelLeadService.createInternalLead)
 * hands over to mirror its domain lead into the canonical Krevia CRM Lead. `requirement` is a short summary
 * — never a full transcript. */
export interface CaptureLeadFromChannelInput {
  organizationId: string;
  /** Fallback source when no Interaction can be resolved for conversationId/voiceSessionId — normally
   * superseded by the resolved Interaction's own channel, which is the authoritative signal. */
  source: LeadSource;
  /** Plugin installation id of the specialist AI Employee this lead is attributed to. */
  agentId?: string | null;
  conversationId?: string | null;
  voiceSessionId?: string | null;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  requirement: string;
}

export interface ListLeadsQuery {
  page: number;
  pageSize: number;
  status?: LeadStatus;
  source?: LeadSource;
  agentId?: string;
  assignedToUserId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}

function paginate<T>(items: T[], total: number, query: { page: number; pageSize: number }) {
  return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolves the Interaction (Sprint 7.12's cross-channel case record) for a conversation/voice session, if
   * any — its `channel` is the authoritative source of truth for WEB_CHAT vs WHATSAPP vs VOICE, and its id
   * is the preferred dedup key since it survives a Receptionist -> specialist handoff (a fresh
   * conversationId is minted on handoff; the Interaction is not). */
  private async resolveInteraction(organizationId: string, conversationId?: string | null, voiceSessionId?: string | null) {
    if (conversationId) {
      const byConversation = await this.prisma.interaction.findFirst({ where: { organizationId, conversationId } });
      if (byConversation) return byConversation;
      // Handoff-aware fallback: a CHANNEL actor's (WhatsApp/voice) specialist conversation reached via a
      // Receptionist handoff never becomes the Interaction's own conversationId —
      // InteractionService.findOrCreate resolves such a turn through its channelConnectionId+
      // externalUserId identity match, which only TOUCHES the existing row (never overwrites an
      // already-set conversationId), unlike the dashboard/web `linkedConversationId` re-point path. Walk
      // the handoff back to its origin (Receptionist) conversation, which the Interaction IS still linked
      // to, instead of duplicating a whole InteractionService resolution here.
      const handoff = await this.prisma.receptionistHandoff.findFirst({
        where: { organizationId, targetConversationId: conversationId }
      });
      if (handoff) {
        const byHandoffOrigin = await this.prisma.interaction.findFirst({
          where: { organizationId, conversationId: handoff.conversationId }
        });
        if (byHandoffOrigin) return byHandoffOrigin;
      }
    }
    if (voiceSessionId) {
      return this.prisma.interaction.findFirst({ where: { organizationId, voiceSessionId } });
    }
    return null;
  }

  private mapInteractionChannel(channel: "WEB_CHAT" | "WHATSAPP" | "VOICE"): LeadSource {
    return channel;
  }

  private async generateReference(): Promise<string> {
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      const candidate = generateLeadReference("KRV-LD");
      const exists = await this.prisma.lead.findUnique({ where: { leadReferenceId: candidate } });
      if (!exists) return candidate;
    }
    throw new Error("LEAD_REFERENCE_ID_EXHAUSTED");
  }

  private async logActivity(
    organizationId: string,
    leadId: string,
    type: LeadActivityType,
    input: { note?: string | null; metadata?: Record<string, unknown>; actorUserId?: string | null } = {}
  ): Promise<void> {
    await this.prisma.leadActivity.create({
      data: {
        organizationId,
        leadId,
        type,
        note: input.note ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        actorUserId: input.actorUserId ?? null
      }
    });
  }

  /**
   * Creates a fresh Lead, or — when the same Interaction/conversation already has an active (not
   * CONVERTED/LOST) Lead — updates it in place. Never fails the caller's own domain-lead persistence: every
   * call site wraps this in a try/catch and logs-and-continues on failure (CRM optionality applies just as
   * much to this internal mirror as it does to any external connector).
   */
  async captureFromChannel(input: CaptureLeadFromChannelInput): Promise<Lead> {
    const interaction = await this.resolveInteraction(input.organizationId, input.conversationId, input.voiceSessionId);
    const source = interaction ? this.mapInteractionChannel(interaction.channel) : input.source;
    const interactionId = interaction?.id ?? null;

    const existing = await this.prisma.lead.findFirst({
      where: {
        organizationId: input.organizationId,
        status: { in: ACTIVE_STATUSES },
        OR: [
          ...(interactionId ? [{ interactionId }] : []),
          ...(input.conversationId ? [{ conversationId: input.conversationId }] : [])
        ]
      },
      orderBy: { createdAt: "desc" }
    });

    if (existing) {
      const updated = await this.prisma.lead.update({
        where: { id: existing.id },
        data: {
          name: existing.name ?? input.name ?? null,
          phone: existing.phone ?? input.phone ?? null,
          email: existing.email ?? input.email ?? null,
          agentId: input.agentId ?? existing.agentId,
          interactionId: interactionId ?? existing.interactionId,
          voiceSessionId: input.voiceSessionId ?? existing.voiceSessionId,
          requirement: input.requirement,
          lastActivityAt: new Date()
        }
      });
      await this.logActivity(input.organizationId, existing.id, "UPDATED", {
        note: "Lead updated from a continued conversation."
      });
      return updated;
    }

    const leadReferenceId = await this.generateReference();
    const created = await this.prisma.lead.create({
      data: {
        organizationId: input.organizationId,
        leadReferenceId,
        name: input.name ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        source,
        agentId: input.agentId ?? null,
        conversationId: input.conversationId ?? null,
        interactionId,
        voiceSessionId: input.voiceSessionId ?? null,
        requirement: input.requirement,
        status: "NEW",
        priority: "MEDIUM",
        lastActivityAt: new Date()
      }
    });
    await this.logActivity(input.organizationId, created.id, "CREATED", {
      note: `Lead captured via ${source}.`
    });
    return created;
  }

  async create(
    organizationId: string,
    actorUserId: string,
    input: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      requirement?: string | null;
      priority?: LeadPriority;
      assignedToUserId?: string | null;
    }
  ): Promise<Lead> {
    const leadReferenceId = await this.generateReference();
    const created = await this.prisma.lead.create({
      data: {
        organizationId,
        leadReferenceId,
        name: input.name ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        source: "MANUAL",
        requirement: input.requirement ?? null,
        priority: input.priority ?? "MEDIUM",
        assignedToUserId: input.assignedToUserId ?? null,
        status: "NEW",
        lastActivityAt: new Date()
      }
    });
    await this.logActivity(organizationId, created.id, "CREATED", {
      note: "Lead created manually.",
      actorUserId
    });
    if (input.assignedToUserId) {
      await this.logActivity(organizationId, created.id, "ASSIGNED", { actorUserId });
    }
    return created;
  }

  async list(organizationId: string, query: ListLeadsQuery) {
    const where: Prisma.LeadWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.assignedToUserId ? { assignedToUserId: query.assignedToUserId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { phone: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
              { leadReferenceId: { contains: query.search, mode: "insensitive" } }
            ]
          }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? { createdAt: { ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}), ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}) } }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.lead.count({ where })
    ]);
    return paginate(items, total, query);
  }

  async get(organizationId: string, id: string): Promise<Lead> {
    const lead = await this.prisma.lead.findFirst({ where: { id, organizationId } });
    if (!lead) throw new NotFoundException("LEAD_NOT_FOUND");
    return lead;
  }

  async getByReference(organizationId: string, leadReferenceId: string): Promise<Lead> {
    const lead = await this.prisma.lead.findFirst({ where: { organizationId, leadReferenceId } });
    if (!lead) throw new NotFoundException("LEAD_NOT_FOUND");
    return lead;
  }

  async update(
    organizationId: string,
    actorUserId: string,
    id: string,
    input: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
      requirement?: string | null;
      status?: LeadStatus;
      priority?: LeadPriority;
    }
  ): Promise<Lead> {
    const existing = await this.get(organizationId, id);
    const data: Prisma.LeadUpdateInput = { lastActivityAt: new Date() };
    if (input.name !== undefined) data.name = input.name;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.email !== undefined) data.email = input.email;
    if (input.requirement !== undefined) data.requirement = input.requirement;
    if (input.priority !== undefined) data.priority = input.priority;

    const nextStatus = input.status;
    const statusChanged = nextStatus !== undefined && nextStatus !== existing.status;
    if (statusChanged && nextStatus !== undefined) {
      data.status = nextStatus;
      if (nextStatus === "CONVERTED") data.convertedAt = new Date();
      if (nextStatus === "LOST") data.lostAt = new Date();
    }

    const updated = await this.prisma.lead.update({ where: { id }, data });

    if (statusChanged) {
      await this.logActivity(organizationId, id, "STATUS_CHANGED", {
        note: `Status changed from ${existing.status} to ${input.status}.`,
        metadata: { from: existing.status, to: input.status },
        actorUserId
      });
      if (input.status === "CONVERTED") await this.logActivity(organizationId, id, "CONVERTED", { actorUserId });
      if (input.status === "LOST") await this.logActivity(organizationId, id, "LOST", { actorUserId });
      if (input.status === "CONTACTED") await this.logActivity(organizationId, id, "CONTACTED", { actorUserId });
    } else {
      await this.logActivity(organizationId, id, "UPDATED", { actorUserId });
    }
    return updated;
  }

  async assign(organizationId: string, actorUserId: string, id: string, assignedToUserId: string | null): Promise<Lead> {
    await this.get(organizationId, id);
    if (assignedToUserId) {
      const assignee = await this.prisma.user.findFirst({ where: { id: assignedToUserId, organizationId, deletedAt: null } });
      if (!assignee) throw new NotFoundException("ASSIGNEE_NOT_FOUND");
    }
    const updated = await this.prisma.lead.update({
      where: { id },
      data: { assignedToUserId, lastActivityAt: new Date() }
    });
    await this.logActivity(organizationId, id, "ASSIGNED", {
      note: assignedToUserId ? "Lead assigned." : "Lead unassigned.",
      metadata: { assignedToUserId },
      actorUserId
    });
    return updated;
  }

  async addNote(organizationId: string, actorUserId: string, id: string, note: string): Promise<void> {
    await this.get(organizationId, id);
    await this.prisma.lead.update({ where: { id }, data: { lastActivityAt: new Date() } });
    await this.logActivity(organizationId, id, "NOTE_ADDED", { note, actorUserId });
  }

  async activity(organizationId: string, id: string) {
    await this.get(organizationId, id);
    return this.prisma.leadActivity.findMany({ where: { organizationId, leadId: id }, orderBy: { createdAt: "desc" } });
  }

  async summary(organizationId: string) {
    const grouped = await this.prisma.lead.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: { _all: true }
    });
    const byStatus = Object.fromEntries(grouped.map((row) => [row.status, row._count._all])) as Record<LeadStatus, number>;
    const total = grouped.reduce((sum, row) => sum + row._count._all, 0);
    return {
      total,
      new: byStatus.NEW ?? 0,
      contacted: byStatus.CONTACTED ?? 0,
      qualified: byStatus.QUALIFIED ?? 0,
      followUp: byStatus.FOLLOW_UP ?? 0,
      converted: byStatus.CONVERTED ?? 0,
      lost: byStatus.LOST ?? 0
    };
  }
}
