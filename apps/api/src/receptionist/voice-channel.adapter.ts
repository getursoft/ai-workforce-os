import { Inject, Injectable } from "@nestjs/common";
import { Prisma, VoiceSessionStatus, VoiceTransport, VoiceDirection } from "@prisma/client";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { AgentService } from "../agents/agent.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

// Sprint 7: the provider-neutral call-control/speech interfaces that used to live here
// (VoiceChannelAdapter/SpeechToTextAdapter/TextToSpeechAdapter) had zero implementations and zero
// consumers — superseded by the more precise VoiceTransportProvider/RealtimeSpeechProvider contracts in
// ../voice/voice.types.ts, which are fitted to the actual Twilio Media Streams wire shape.

const LIVE_STATUSES = ["CREATED", "RINGING", "CONNECTING", "ACTIVE", "INTERRUPTED", "ENDING"] as const;

@Injectable()
export class VoiceSessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  enabled(): boolean {
    return this.config.boolean("RECEPTIONIST_VOICE_ENABLED", false);
  }

  async active(organizationId: string, sessionId: string) {
    if (!this.enabled()) throw new Error("RECEPTIONIST_VOICE_DISABLED");
    const session = await this.prisma.voiceSession.findFirst({
      where: { id: sessionId, organizationId, status: "ACTIVE" }
    });
    if (!session) throw new Error("VOICE_SESSION_NOT_FOUND");
    return session;
  }

  async start(input: {
    organizationId: string;
    channelConnectionId: string;
    customerIdentityId?: string | null;
    receptionistConversationId: string;
    provider: string;
    providerCallId: string;
    metadata?: Record<string, unknown>;
  }) {
    if (!this.enabled()) throw new Error("RECEPTIONIST_VOICE_DISABLED");
    const channel = await this.prisma.channelConnection.findFirst({
      where: {
        id: input.channelConnectionId,
        organizationId: input.organizationId,
        status: "ACTIVE",
        deletedAt: null
      },
      select: { id: true }
    });
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: input.receptionistConversationId,
        organizationId: input.organizationId,
        deletedAt: null
      },
      select: { id: true }
    });
    if (!channel || !conversation) throw new Error("VOICE_SESSION_SCOPE_INVALID");
    return this.prisma.voiceSession.create({
      data: {
        organizationId: input.organizationId,
        channelConnectionId: input.channelConnectionId,
        customerIdentityId: input.customerIdentityId ?? null,
        receptionistConversationId: input.receptionistConversationId,
        provider: input.provider,
        providerCallId: input.providerCallId,
        status: VoiceSessionStatus.ACTIVE,
        metadataJson: (input.metadata ?? {}) as Prisma.InputJsonValue
      }
    });
  }

  /** Sprint 7: creates the durable session for a real inbound call at webhook-time, before any
   * receptionist conversation exists — the conversation is linked once the first transcript turn
   * creates/resolves it (see linkConversation). Idempotent on the provider call id via the existing
   * @@unique([organizationId, provider, providerCallId]) constraint — a duplicate webhook delivery
   * throws Prisma P2002, which callers should treat as "session already exists" and re-fetch. */
  async createRinging(input: {
    organizationId: string;
    channelConnectionId: string;
    provider: string;
    providerCallId: string;
    transport: VoiceTransport;
    direction?: VoiceDirection;
    externalCallerId?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    if (!this.enabled()) throw new Error("RECEPTIONIST_VOICE_DISABLED");
    const channel = await this.prisma.channelConnection.findFirst({
      where: {
        id: input.channelConnectionId,
        organizationId: input.organizationId,
        status: "ACTIVE",
        deletedAt: null
      },
      select: { id: true, voiceEnabled: true }
    });
    if (!channel || !channel.voiceEnabled) throw new Error("VOICE_SESSION_SCOPE_INVALID");
    return this.prisma.voiceSession.create({
      data: {
        organizationId: input.organizationId,
        channelConnectionId: input.channelConnectionId,
        provider: input.provider,
        providerCallId: input.providerCallId,
        transport: input.transport,
        direction: input.direction ?? VoiceDirection.INBOUND,
        externalCallerId: input.externalCallerId ?? null,
        status: VoiceSessionStatus.RINGING,
        lastActivityAt: new Date(),
        metadataJson: (input.metadata ?? {}) as Prisma.InputJsonValue
      }
    });
  }

  async findByProviderCallId(organizationId: string, provider: string, providerCallId: string) {
    return this.prisma.voiceSession.findFirst({ where: { organizationId, provider, providerCallId } });
  }

  /** Sets the receptionist conversation once known — a no-op if already linked (idempotent under
   * webhook/media-event retries), never overwrites an existing link with a different conversation. */
  async linkConversation(organizationId: string, sessionId: string, conversationId: string) {
    await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, receptionistConversationId: null },
      data: { receptionistConversationId: conversationId }
    });
  }

  async markStreamStarted(organizationId: string, sessionId: string, providerStreamId: string) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: ["CREATED", "RINGING"] } },
      data: { status: VoiceSessionStatus.CONNECTING, providerStreamId, lastActivityAt: new Date() }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  async markActive(organizationId: string, sessionId: string) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: ["CREATED", "RINGING", "CONNECTING"] } },
      data: { status: VoiceSessionStatus.ACTIVE, answeredAt: new Date(), lastActivityAt: new Date() }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  /** Barge-in: the caller started speaking while the agent's response was still being generated/played. */
  async interrupt(organizationId: string, sessionId: string) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: "ACTIVE" },
      data: { status: VoiceSessionStatus.INTERRUPTED, lastActivityAt: new Date() }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  async resume(organizationId: string, sessionId: string) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: "INTERRUPTED" },
      data: { status: VoiceSessionStatus.ACTIVE, lastActivityAt: new Date() }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  async touchActivity(organizationId: string, sessionId: string) {
    await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: LIVE_STATUSES as unknown as VoiceSessionStatus[] } },
      data: { lastActivityAt: new Date() }
    });
  }

  async attachHandoff(organizationId: string, sessionId: string, handoffId: string) {
    const handoff = await this.prisma.receptionistHandoff.findFirst({
      where: { id: handoffId, organizationId },
      select: { id: true }
    });
    if (!handoff) throw new Error("VOICE_HANDOFF_SCOPE_INVALID");
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: "ACTIVE" },
      data: { activeHandoffId: handoffId }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  async recordTurnMetrics(
    organizationId: string,
    sessionId: string,
    metrics: {
      speechEndToAckMs?: number;
      routingMs?: number;
      specialistFirstResponseMs?: number;
      totalTurnMs?: number;
    }
  ) {
    if (
      Object.values(metrics).some(
        (value) => value !== undefined && (!Number.isInteger(value) || value < 0)
      )
    )
      throw new Error("VOICE_METRICS_INVALID");
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: "ACTIVE" },
      data: metrics
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
  }

  /** Transitional state while the final transcript/turn is flushed before the session is fully closed —
   * optional; callers that don't need it can go straight to end(). */
  async beginEnding(organizationId: string, sessionId: string) {
    await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: LIVE_STATUSES as unknown as VoiceSessionStatus[] } },
      data: { status: VoiceSessionStatus.ENDING, lastActivityAt: new Date() }
    });
  }

  /** Idempotent: repeated stop/end events (a normal provider-webhook-retry scenario) are harmless — a
   * session already ENDED/FAILED simply matches zero rows and this returns without throwing. */
  async end(organizationId: string, sessionId: string, failed = false, terminationReason?: string) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: LIVE_STATUSES as unknown as VoiceSessionStatus[] } },
      data: {
        status: failed ? VoiceSessionStatus.FAILED : VoiceSessionStatus.ENDED,
        endedAt: new Date(),
        ...(terminationReason ? { terminationReason: terminationReason.slice(0, 200) } : {})
      }
    });
    if (updated.count === 0) {
      const existing = await this.prisma.voiceSession.findFirst({ where: { id: sessionId, organizationId } });
      if (!existing) throw new Error("VOICE_SESSION_NOT_FOUND");
      // already terminal — idempotent no-op for a duplicate provider stop/end webhook
    }
  }
}

/** Turns provider-produced final transcripts into normal Receptionist turns. Media streaming, STT, TTS,
 * and call control stay in adapters; this service only correlates the durable voice session and invokes
 * the same AgentService entry point used by web and WhatsApp. */
@Injectable()
export class VoiceReceptionistTurnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: VoiceSessionService,
    private readonly agents: AgentService
  ) {}

  async handleTranscript(input: {
    organizationId: string;
    sessionId: string;
    transcript: string;
    customerExternalId: string;
    requestId: string;
    speechEndedAtEpochMs?: number;
  }) {
    const startedAt = Date.now();
    const transcript = input.transcript.trim().slice(0, 12_000);
    if (!transcript) throw new Error("VOICE_TRANSCRIPT_EMPTY");
    const session = await this.sessions.active(input.organizationId, input.sessionId);
    const channel = await this.prisma.channelConnection.findFirst({
      where: {
        id: session.channelConnectionId,
        organizationId: input.organizationId,
        status: "ACTIVE",
        deletedAt: null
      },
      select: {
        id: true,
        pluginInstallationId: true,
        pluginInstallation: { select: { status: true, manifest: true } }
      }
    });
    if (!channel) throw new Error("VOICE_RECEPTIONIST_SCOPE_INVALID");

    // Continuing call: the conversation already exists — re-verify it's still a receptionist conversation
    // (defence in depth against a channel's assigned agent changing mid-call). First turn of a brand-new
    // call: no conversation yet — the channel's own assigned plugin must be the receptionist; AgentService
    // creates the conversation for us (conversationId omitted), exactly the same as a fresh WhatsApp text.
    const conversationId: string | undefined = session.receptionistConversationId ?? undefined;
    let agentId: string;
    if (conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organizationId: input.organizationId, deletedAt: null },
        select: {
          id: true,
          pluginInstallationId: true,
          pluginInstallation: { select: { status: true, manifest: true } }
        }
      });
      if (
        !conversation ||
        conversation.pluginInstallation.status !== "ACTIVE" ||
        !manifestCapabilities(conversation.pluginInstallation.manifest).includes("workforce.intake")
      )
        throw new Error("VOICE_RECEPTIONIST_SCOPE_INVALID");
      agentId = conversation.pluginInstallationId;
    } else {
      if (
        channel.pluginInstallation.status !== "ACTIVE" ||
        !manifestCapabilities(channel.pluginInstallation.manifest).includes("workforce.intake")
      )
        throw new Error("VOICE_RECEPTIONIST_SCOPE_INVALID");
      agentId = channel.pluginInstallationId;
    }

    const acknowledgement = "Sure, I'm connecting you with the right specialist.";
    const result = await this.agents.execute({
      organizationId: input.organizationId,
      agentId,
      ...(conversationId ? { conversationId } : {}),
      actor: {
        type: "CHANNEL",
        channelConnectionId: channel.id,
        externalUserId: input.customerExternalId.slice(0, 64)
      },
      text: transcript,
      source: {
        type: "VOICE",
        channelId: channel.id,
        providerCallId: session.providerCallId
      },
      requestId: input.requestId,
      metadata: { voiceSessionId: session.id }
    });
    if (!conversationId && result.conversationId)
      await this.sessions.linkConversation(input.organizationId, session.id, result.conversationId);
    const handoff = "receptionist" in result ? result.receptionist.handoff : null;
    if (handoff) await this.sessions.attachHandoff(input.organizationId, session.id, handoff.id);
    const finishedAt = Date.now();
    await this.sessions.recordTurnMetrics(input.organizationId, session.id, {
      ...(input.speechEndedAtEpochMs !== undefined
        ? { speechEndToAckMs: Math.max(0, startedAt - input.speechEndedAtEpochMs) }
        : {}),
      routingMs: finishedAt - startedAt,
      totalTurnMs: finishedAt - startedAt
    });
    return { acknowledgement, result };
  }
}

function manifestCapabilities(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities)
    ? capabilities.filter((item): item is string => typeof item === "string")
    : [];
}
