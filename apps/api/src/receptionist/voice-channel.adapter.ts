import { Inject, Injectable } from "@nestjs/common";
import { Prisma, VoiceSessionStatus } from "@prisma/client";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { AgentService } from "../agents/agent.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface VoiceCallReference {
  provider: string;
  providerCallId: string;
}

/** Provider-neutral call control. Twilio, Meta, SIP, or another provider implements this boundary; the
 * receptionist routing domain never imports a provider SDK or wire format. */
export interface VoiceChannelAdapter {
  acceptCall(call: VoiceCallReference): Promise<void>;
  startCall(input: { to: string; from?: string }): Promise<VoiceCallReference>;
  receiveTranscript(call: VoiceCallReference): AsyncIterable<{ text: string; isFinal: boolean }>;
  sendAudio(call: VoiceCallReference, audio: Uint8Array): Promise<void>;
  speakText(call: VoiceCallReference, text: string): Promise<void>;
  endCall(call: VoiceCallReference): Promise<void>;
  getCallStatus(call: VoiceCallReference): Promise<string>;
}

export interface SpeechToTextAdapter {
  transcribe(audio: Uint8Array, options?: { locale?: string }): Promise<string>;
}

export interface TextToSpeechAdapter {
  synthesize(text: string, options?: { locale?: string; voice?: string }): Promise<Uint8Array>;
}

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

  async end(organizationId: string, sessionId: string, failed = false) {
    const updated = await this.prisma.voiceSession.updateMany({
      where: { id: sessionId, organizationId, status: { in: ["RINGING", "ACTIVE"] } },
      data: {
        status: failed ? VoiceSessionStatus.FAILED : VoiceSessionStatus.ENDED,
        endedAt: new Date()
      }
    });
    if (updated.count !== 1) throw new Error("VOICE_SESSION_NOT_FOUND");
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
    const [conversation, channel] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: {
          id: session.receptionistConversationId,
          organizationId: input.organizationId,
          deletedAt: null
        },
        select: {
          id: true,
          pluginInstallationId: true,
          pluginInstallation: { select: { status: true, manifest: true } }
        }
      }),
      this.prisma.channelConnection.findFirst({
        where: {
          id: session.channelConnectionId,
          organizationId: input.organizationId,
          status: "ACTIVE",
          deletedAt: null
        },
        select: { id: true }
      })
    ]);
    if (
      !conversation ||
      !channel ||
      conversation.pluginInstallation.status !== "ACTIVE" ||
      !manifestCapabilities(conversation.pluginInstallation.manifest).includes("workforce.intake")
    )
      throw new Error("VOICE_RECEPTIONIST_SCOPE_INVALID");

    const acknowledgement = "Sure, I'm connecting you with the right specialist.";
    const result = await this.agents.execute({
      organizationId: input.organizationId,
      agentId: conversation.pluginInstallationId,
      conversationId: conversation.id,
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
