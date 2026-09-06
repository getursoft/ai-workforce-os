/** Sprint 7.11 — STEP 4: Call History API. Read-only, tenant-scoped access to the voice sessions and
 * transcript segments already persisted by VoiceSessionEngine/VoiceTranscriptService — no new event
 * types, no raw audio exposure (none is ever persisted). Mirrors channel.service.ts's pagination and
 * tenant-scoping pattern (`page()` helper, `$transaction([findMany, count])`) rather than inventing a
 * new one.
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { VoiceSessionListQueryDto, VoiceTranscriptQueryDto } from "./voice-call-history.dto";
import { resolveVoicePrivacyConfig } from "./voice-config";

function page(items: unknown[], total: number, query: { page: number; pageSize: number }) {
  return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
}

/** Masks all but the last 4 characters of an external caller identifier (E.164 phone number or similar)
 * so full identifiers are never exposed by default — e.g. "+14155551234" -> "+*******1234". Controlled
 * by VOICE_MASK_CALLER_ID (default true, see resolveVoicePrivacyConfig) — `mask: false` returns the
 * caller id unchanged for a deployment that has deliberately opted out. */
export function maskCallerId(callerId: string | null, mask = true): string | null {
  if (!callerId || !mask) return callerId;
  const visible = callerId.slice(-4);
  return `${"*".repeat(Math.max(callerId.length - 4, 1))}${visible}`;
}

@Injectable()
export class VoiceCallHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async list(organizationId: string, query: VoiceSessionListQueryDto) {
    const where: Prisma.VoiceSessionWhereInput = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.transport ? { transport: query.transport } : {}),
      ...(query.channelConnectionId ? { channelConnectionId: query.channelConnectionId } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            startedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {})
            }
          }
        : {}),
      ...(query.agentId ? { receptionistConversationId: { in: await this.conversationIdsForAgent(organizationId, query.agentId) } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.voiceSession.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.voiceSession.count({ where })
    ]);
    return page(items.map((s) => this.toSummary(s)), total, query);
  }

  async get(organizationId: string, id: string) {
    const session = await this.prisma.voiceSession.findFirst({ where: { organizationId, id } });
    if (!session) throw new NotFoundException("Voice session not found");
    const handoffs = session.receptionistConversationId
      ? await this.prisma.receptionistHandoff.findMany({
          where: { organizationId, conversationId: session.receptionistConversationId },
          orderBy: { startedAt: "asc" },
          select: {
            id: true,
            status: true,
            targetEmployeeInstallationId: true,
            targetConversationId: true,
            routingIntent: true,
            routingCapability: true,
            startedAt: true,
            completedAt: true
          }
        })
      : [];
    return { ...this.toSummary(session), handoffs };
  }

  async transcript(organizationId: string, id: string, query: VoiceTranscriptQueryDto) {
    await this.get(organizationId, id);
    const where: Prisma.VoiceTranscriptSegmentWhereInput = { organizationId, voiceSessionId: id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.voiceTranscriptSegment.findMany({
        where,
        orderBy: { sequenceNumber: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          speaker: true,
          text: true,
          isFinal: true,
          startedAt: true,
          endedAt: true,
          confidence: true,
          sequenceNumber: true,
          createdAt: true
        }
      }),
      this.prisma.voiceTranscriptSegment.count({ where })
    ]);
    return page(items, total, query);
  }

  private async conversationIdsForAgent(organizationId: string, agentId: string): Promise<string[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, pluginInstallationId: agentId },
      select: { id: true }
    });
    return conversations.map((c) => c.id);
  }

  private toSummary(session: {
    id: string;
    organizationId: string;
    channelConnectionId: string;
    receptionistConversationId: string | null;
    activeHandoffId: string | null;
    provider: string;
    providerCallId: string;
    providerStreamId: string | null;
    externalCallerId: string | null;
    transport: string;
    direction: string;
    status: string;
    startedAt: Date;
    answeredAt: Date | null;
    endedAt: Date | null;
    lastActivityAt: Date | null;
    terminationReason: string | null;
    speechEndToAckMs: number | null;
    routingMs: number | null;
    specialistFirstResponseMs: number | null;
    totalTurnMs: number | null;
  }) {
    const durationSeconds =
      session.answeredAt && session.endedAt
        ? Math.max(0, Math.round((session.endedAt.getTime() - session.answeredAt.getTime()) / 1000))
        : null;
    return {
      id: session.id,
      channelConnectionId: session.channelConnectionId,
      receptionistConversationId: session.receptionistConversationId,
      activeHandoffId: session.activeHandoffId,
      provider: session.provider,
      providerCallId: session.providerCallId,
      providerStreamId: session.providerStreamId,
      callerId: maskCallerId(session.externalCallerId, resolveVoicePrivacyConfig(this.config).maskCallerId),
      transport: session.transport,
      direction: session.direction,
      status: session.status,
      startedAt: session.startedAt,
      answeredAt: session.answeredAt,
      endedAt: session.endedAt,
      lastActivityAt: session.lastActivityAt,
      durationSeconds,
      terminationReason: session.terminationReason,
      speechEndToAckMs: session.speechEndToAckMs,
      routingMs: session.routingMs,
      specialistFirstResponseMs: session.specialistFirstResponseMs,
      totalTurnMs: session.totalTurnMs
    };
  }
}
