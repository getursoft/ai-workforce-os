import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  ChannelConnectionStatus,
  ChannelMessageDirection,
  ChannelMessageStatus,
  PluginStatus,
  type ChannelMessage
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { AgentService } from "../agents/agent.service";
import { normalizeWhatsAppAddress, TwilioClient, TwilioProviderError } from "./channel.runtime";

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;

/**
 * Small database-backed retryable worker: no external queue infrastructure exists in this
 * codebase, so pending work is tracked as rows on `channel_messages` and claimed via an
 * atomic conditional UPDATE (safe under concurrent pollers / multiple instances).
 */
@Injectable()
export class ChannelMessageProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelMessageProcessor.name);
  private readonly twilio = new TwilioClient();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly auditLogger: AuditEventLogger,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  onModuleInit() {
    if (this.security.nodeEnvironment === "test") return;
    this.timer = setInterval(() => void this.processOnce(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire-and-forget nudge so the common case doesn't wait for the next poll tick. */
  trigger(): void {
    void this.processOnce().catch((error) =>
      this.logger.error({ event: "CHANNEL_PROCESSOR_TRIGGER_FAILED", code: safeCode(error) })
    );
  }

  async processOnce(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let processed = 0;
      for (const id of await this.findCandidateIds("INBOUND", "RECEIVED", limit, false)) {
        const claimed = await this.claim(id, "INBOUND", ["RECEIVED"]);
        if (!claimed) continue;
        await this.handleInbound(claimed);
        processed++;
      }
      // Outbound retries are only ever scheduled with a concrete nextAttemptAt; a NULL means the
      // retry budget was exhausted and the row is a terminal failure, not fresh work.
      for (const id of await this.findCandidateIds("OUTBOUND", "FAILED", limit, true)) {
        const claimed = await this.claim(id, "OUTBOUND", ["FAILED"]);
        if (!claimed) continue;
        await this.handleOutboundRetry(claimed);
        processed++;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async findCandidateIds(
    direction: ChannelMessageDirection,
    status: ChannelMessageStatus,
    limit: number,
    requireScheduledRetry: boolean
  ): Promise<string[]> {
    const now = new Date();
    const stale = new Date(now.getTime() - STALE_PROCESSING_MS);
    const rows = await this.prisma.channelMessage.findMany({
      where: {
        direction,
        OR: [
          {
            status,
            ...(requireScheduledRetry
              ? { nextAttemptAt: { lte: now } }
              : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] })
          },
          { status: ChannelMessageStatus.PROCESSING, updatedAt: { lte: stale } }
        ]
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true }
    });
    return rows.map((row) => row.id);
  }

  private async claim(
    id: string,
    direction: ChannelMessageDirection,
    statuses: ChannelMessageStatus[]
  ): Promise<ChannelMessage | null> {
    const stale = new Date(Date.now() - STALE_PROCESSING_MS);
    const result = await this.prisma.channelMessage.updateMany({
      where: {
        id,
        direction,
        OR: [
          { status: { in: statuses } },
          { status: ChannelMessageStatus.PROCESSING, updatedAt: { lte: stale } }
        ]
      },
      data: { status: ChannelMessageStatus.PROCESSING, processingAttempts: { increment: 1 } }
    });
    if (result.count !== 1) return null;
    return this.prisma.channelMessage.findUnique({ where: { id } });
  }

  private async handleInbound(message: ChannelMessage): Promise<void> {
    try {
      const channel = await this.prisma.channelConnection.findFirst({
        where: { id: message.channelConnectionId, organizationId: message.organizationId, deletedAt: null },
        include: { pluginInstallation: true }
      });
      if (
        !channel ||
        channel.status !== ChannelConnectionStatus.ACTIVE ||
        channel.pluginInstallation.status !== PluginStatus.ACTIVE
      ) {
        await this.terminateInbound(message, "CHANNEL_UNAVAILABLE");
        this.audit(message.organizationId, message.channelConnectionId, "CHANNEL_MESSAGE_FAILED");
        return;
      }
      if (!message.body) {
        await this.terminateInbound(message, "EMPTY_MESSAGE_BODY");
        this.audit(message.organizationId, message.channelConnectionId, "CHANNEL_MESSAGE_FAILED");
        return;
      }
      const externalUserId = normalizeWhatsAppAddress(message.fromAddress).externalUserId;
      const existingConversation = await this.prisma.conversation.findFirst({
        where: {
          organizationId: message.organizationId,
          channelConnectionId: channel.id,
          externalUserId,
          status: "ACTIVE",
          deletedAt: null
        },
        orderBy: { updatedAt: "desc" }
      });
      const result = await this.agents.execute({
        organizationId: message.organizationId,
        agentId: channel.pluginInstallationId,
        ...(existingConversation ? { conversationId: existingConversation.id } : {}),
        actor: { type: "CHANNEL", channelConnectionId: channel.id, externalUserId },
        text: message.body,
        source: { type: "CHANNEL", channelId: channel.id, externalUserId },
        requestId: message.id,
        metadata: { channelMessageId: message.id }
      });
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: { conversationId: result.conversationId, agentExecutionId: result.executionId }
      });
      const configuration = (channel.configuration ?? {}) as { fromNumber?: string };
      const outbound = await this.prisma.channelMessage.create({
        data: {
          organizationId: message.organizationId,
          channelConnectionId: channel.id,
          conversationId: result.conversationId,
          agentExecutionId: result.executionId,
          provider: "TWILIO",
          direction: ChannelMessageDirection.OUTBOUND,
          status: ChannelMessageStatus.PROCESSING,
          fromAddress: normalizeWhatsAppAddress(configuration.fromNumber ?? "").address,
          toAddress: message.fromAddress,
          body: result.response
        }
      });
      const delivered = await this.sendOutbound(channel, outbound);
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: { status: ChannelMessageStatus.SENT }
      });
      this.audit(
        message.organizationId,
        channel.id,
        delivered ? "CHANNEL_MESSAGE_SENT" : "CHANNEL_MESSAGE_FAILED"
      );
    } catch (error) {
      const code = safeCode(error);
      this.logger.warn({ event: "CHANNEL_INBOUND_PROCESSING_FAILED", messageId: message.id, code });
      await this.retryOrFailInbound(message, code);
      this.audit(message.organizationId, message.channelConnectionId, "CHANNEL_MESSAGE_FAILED");
    }
  }

  private async handleOutboundRetry(message: ChannelMessage): Promise<void> {
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: message.channelConnectionId, organizationId: message.organizationId, deletedAt: null }
    });
    if (!channel) {
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: { status: ChannelMessageStatus.FAILED, errorCode: "CHANNEL_UNAVAILABLE", nextAttemptAt: null }
      });
      return;
    }
    await this.sendOutbound(channel, message);
  }

  /** Sends (or resends) an outbound row via Twilio and persists the delivery/failure outcome. */
  private async sendOutbound(
    channel: { id: string; configuration: unknown; encryptedSecrets: unknown },
    outbound: ChannelMessage
  ): Promise<boolean> {
    const configuration = (channel.configuration ?? {}) as { accountSid?: string; fromNumber?: string };
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    if (!configuration.accountSid || !configuration.fromNumber || !secrets.authToken) {
      await this.prisma.channelMessage.update({
        where: { id: outbound.id },
        data: {
          status: ChannelMessageStatus.FAILED,
          errorCode: "CHANNEL_CREDENTIALS_REQUIRED",
          nextAttemptAt: null
        }
      });
      return false;
    }
    try {
      const sent = await this.twilio.sendWhatsAppMessage({
        accountSid: configuration.accountSid,
        authToken: secrets.authToken,
        from: configuration.fromNumber,
        to: outbound.toAddress,
        body: outbound.body ?? ""
      });
      await this.prisma.channelMessage.update({
        where: { id: outbound.id },
        data: {
          status: ChannelMessageStatus.SENT,
          providerMessageSid: sent.providerMessageSid,
          sentAt: new Date()
        }
      });
      return true;
    } catch (error) {
      const code = error instanceof TwilioProviderError ? error.code : "CHANNEL_PROVIDER_UNAVAILABLE";
      const attempts = outbound.processingAttempts;
      const retryable = attempts < MAX_ATTEMPTS;
      await this.prisma.channelMessage.update({
        where: { id: outbound.id },
        data: {
          status: ChannelMessageStatus.FAILED,
          errorCode: code,
          errorMessage: "Outbound WhatsApp delivery failed",
          nextAttemptAt: retryable ? backoff(attempts) : null
        }
      });
      return false;
    }
  }

  private async retryOrFailInbound(message: ChannelMessage, code: string): Promise<void> {
    const attempts = message.processingAttempts;
    const retryable = attempts < MAX_ATTEMPTS;
    await this.prisma.channelMessage.update({
      where: { id: message.id },
      data: {
        status: retryable ? ChannelMessageStatus.RECEIVED : ChannelMessageStatus.FAILED,
        errorCode: code,
        errorMessage: "Inbound message processing failed",
        nextAttemptAt: retryable ? backoff(attempts) : null
      }
    });
  }

  private async terminateInbound(message: ChannelMessage, code: string): Promise<void> {
    await this.prisma.channelMessage.update({
      where: { id: message.id },
      data: {
        status: ChannelMessageStatus.FAILED,
        errorCode: code,
        errorMessage: "Message could not be processed",
        nextAttemptAt: null
      }
    });
  }

  private audit(organizationId: string, channelConnectionId: string, event: string) {
    this.auditLogger.record(event, "channel-processor", { organizationId, targetId: channelConnectionId });
  }
}

function backoff(attempts: number): Date {
  const seconds = Math.min(5 * 2 ** attempts, 600);
  return new Date(Date.now() + seconds * 1000);
}
function safeCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "CHANNEL_MESSAGE_PROCESSING_FAILED";
}
