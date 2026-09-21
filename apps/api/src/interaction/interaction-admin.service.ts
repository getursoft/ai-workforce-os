/** Sprint 7.12 STEP 26 — read-only, tenant-scoped admin API backing service. Mirrors
 * voice-call-history.service.ts's exact pagination/tenant-scoping pattern (`page()` helper,
 * `$transaction([findMany, count])`) rather than inventing a new one. */
import { Injectable, NotFoundException } from "@nestjs/common";
import { Interaction, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { maskEmail, maskPhone } from "./interaction-privacy";
import type { InteractionListQueryDto } from "./interaction.dto";
import { normalizeReferenceId } from "./reference-id.generator";

function page(items: unknown[], total: number, query: { page: number; pageSize: number }) {
  return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
}

@Injectable()
export class InteractionAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, query: InteractionListQueryDto) {
    const where: Prisma.InteractionWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.agentId ? { OR: [{ entryAgentId: query.agentId }, { currentAgentId: query.agentId }] } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            startedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {})
            }
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.interaction.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.interaction.count({ where })
    ]);
    return page(items.map((item) => this.toSummary(item)), total, query);
  }

  async get(organizationId: string, id: string) {
    const interaction = await this.prisma.interaction.findFirst({ where: { id, organizationId } });
    if (!interaction) throw new NotFoundException("Interaction not found");
    return this.toSummary(interaction);
  }

  async getByReferenceId(organizationId: string, rawReferenceId: string, prefixLength: number) {
    const referenceId = normalizeReferenceId(rawReferenceId, prefixLength);
    const interaction = await this.prisma.interaction.findFirst({ where: { organizationId, referenceId } });
    if (!interaction) throw new NotFoundException("Interaction not found");
    return this.toSummary(interaction);
  }

  async notifications(organizationId: string, id: string) {
    await this.get(organizationId, id);
    return this.prisma.interactionNotification.findMany({
      where: { organizationId, interactionId: id },
      orderBy: { requestedAt: "desc" }
    });
  }

  private toSummary(interaction: Interaction) {
    return {
      id: interaction.id,
      referenceId: interaction.referenceId,
      channel: interaction.channel,
      transport: interaction.transport,
      status: interaction.status,
      conversationId: interaction.conversationId,
      voiceSessionId: interaction.voiceSessionId,
      channelConnectionId: interaction.channelConnectionId,
      entryAgentId: interaction.entryAgentId,
      currentAgentId: interaction.currentAgentId,
      phoneNumber: interaction.phoneNumber ? maskPhone(interaction.phoneNumber) : null,
      email: interaction.email ? maskEmail(interaction.email) : null,
      startedAt: interaction.startedAt,
      lastActivityAt: interaction.lastActivityAt,
      completedAt: interaction.completedAt,
      resolutionSummary: interaction.resolutionSummary,
      referenceCommunicatedAt: interaction.referenceCommunicatedAt
    };
  }
}
