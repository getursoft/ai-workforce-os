import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import {
  ChannelConnectionStatus,
  ChannelMessageDirection,
  ChannelMessageStatus,
  PluginStatus,
  Prisma,
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
import type { AgentExecutionInput, ChannelContact } from "../agents/agent.runtime";
import { normalizeWhatsAppAddress, TwilioClient, TwilioProviderError } from "./channel.runtime";
import { sendMetaWhatsAppText } from "./whatsapp/meta-whatsapp.client";
import { EmployeeRouterService } from "./employee-router.service";
import type { ConversationRoutingState } from "./employee-router.types";
import { DEFAULT_ACKNOWLEDGEMENT_MESSAGE, DEFAULT_FAILURE_MESSAGE } from "./employee-router.types";

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
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Optional() private readonly employeeRouter?: EmployeeRouterService
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
      let agentId = channel.pluginInstallationId;
      let conversationId = message.conversationId ?? undefined;
      let routingResponseText: string | null = null;

      if (!conversationId) {
        const prevConvo = await this.prisma.conversation.findFirst({
          where: { organizationId: message.organizationId, channelConnectionId: channel.id, externalUserId, status: "ACTIVE", deletedAt: null },
          orderBy: { updatedAt: "desc" }
        });
        if (prevConvo) conversationId = prevConvo.id;
      }

      if (channel.routingMode === "INTENT_ROUTER" && this.employeeRouter) {
        let conversation = await this.prisma.conversation.findFirst({
          where: { organizationId: message.organizationId, channelConnectionId: channel.id, externalUserId, status: "ACTIVE", deletedAt: null },
          orderBy: { updatedAt: "desc" }
        });
        const convMeta = conversation?.metadata as Record<string, unknown> | undefined;
        const routingState = convMeta?.routingState as ConversationRoutingState | undefined;

        if (!conversation || routingState?.routingStatus === "AWAITING_INTENT") {
          if (!conversation) {
            conversation = await this.prisma.conversation.create({
              data: { organizationId: message.organizationId, pluginInstallationId: channel.pluginInstallationId, channelConnectionId: channel.id, externalUserId, title: externalUserId, metadata: { routingState: { routingStatus: "AWAITING_INTENT", selectedEmployeeId: null, detectedIntent: null, routingConfidence: 0, routedAt: null, lastRoutedAt: null, clarificationCount: 0 } } }
            });
          }
          if (this.employeeRouter.isGreeting(message.body)) {
            routingResponseText = this.employeeRouter.buildReceptionistGreeting(channel);
            conversationId = conversation.id;
          } else {
            const routeResult = await this.employeeRouter.route(message.body, message.organizationId, channel, routingState ?? null);
            if (routeResult.decision.status === "ROUTED" && routeResult.decision.employeeInstallationId) {
              agentId = routeResult.decision.employeeInstallationId;
              conversationId = conversation.id;
              await this.prisma.conversation.update({
                where: { id: conversation.id },
                data: { metadata: { routingState: { routingStatus: "ROUTED", selectedEmployeeId: agentId, detectedIntent: routeResult.decision.detectedIntent ?? null, routingConfidence: routeResult.decision.confidence, routedAt: new Date().toISOString(), lastRoutedAt: new Date().toISOString(), clarificationCount: (routingState?.clarificationCount ?? 0) } } }
              });
            } else {
              routingResponseText = routeResult.responseText;
              conversationId = conversation.id;
            }
          }
        } else if (routingState?.routingStatus === "ROUTED" && routingState.selectedEmployeeId) {
          agentId = routingState.selectedEmployeeId;
          conversationId = conversation.id;
        }
      }

      const channelContact = channel.provider === "META_CLOUD_API" ? {
        channel: "WHATSAPP" as const, provider: "META_CLOUD_API",
        senderPhoneNumber: externalUserId, senderWhatsAppId: externalUserId,
        verificationSource: "PROVIDER" as const, verified: true as const,
        channelConnectionId: channel.id, organizationId: message.organizationId
      } as ChannelContact : undefined;

      let result: { conversationId: string; executionId: string; response: string } | null = null;
      let responseText = routingResponseText ?? "";
      if (!routingResponseText) {
        const ackEnabled = channel.routingMode === "INTENT_ROUTER" && channel.processingAcknowledgementEnabled !== false && channel.processingAcknowledgementMode !== "DISABLED";
        if (ackEnabled) {
          const ackMsg = channel.processingAcknowledgementMessage ?? DEFAULT_ACKNOWLEDGEMENT_MESSAGE;
          await this.prisma.channelMessage.create({ data: { organizationId: message.organizationId, channelConnectionId: channel.id, conversationId: conversationId ?? null, provider: channel.provider, direction: ChannelMessageDirection.OUTBOUND, status: ChannelMessageStatus.SENT, fromAddress: channel.displayPhoneNumber ?? channel.phoneNumberId ?? "", toAddress: message.fromAddress, body: ackMsg } as unknown as Prisma.ChannelMessageCreateInput });
          await this.sendOutbound(channel as Parameters<typeof this.sendOutbound>[0], { id: `ack-${message.id}`, toAddress: message.fromAddress, body: ackMsg, provider: channel.provider } as Parameters<typeof this.sendOutbound>[1]);
        }
        try {
          result = await this.agents.execute(Object.assign({ organizationId: message.organizationId, agentId, actor: { type: "CHANNEL" as const, channelConnectionId: channel.id, externalUserId }, text: message.body, source: { type: "CHANNEL" as const, channelId: channel.id, externalUserId }, requestId: message.id, metadata: { channelMessageId: message.id } }, conversationId ? { conversationId } : {}, channelContact ? { channelContact } : {}) as AgentExecutionInput);
          responseText = result?.response ?? "";
        } catch {
          responseText = DEFAULT_FAILURE_MESSAGE;
        }
        if (ackEnabled && !responseText) responseText = DEFAULT_FAILURE_MESSAGE;
      }
      const resolvedConversationId = result?.conversationId ?? conversationId;
      const agentExecutionId = result?.executionId;

      const updateData: Record<string, unknown> = {};
      if (resolvedConversationId) updateData.conversationId = resolvedConversationId;
      if (agentExecutionId) updateData.agentExecutionId = agentExecutionId;
      if (Object.keys(updateData).length > 0) {
        await this.prisma.channelMessage.update({ where: { id: message.id }, data: updateData as unknown as Prisma.ChannelMessageUpdateInput });
      }
      const isMeta = channel.provider === "META_CLOUD_API";
      const outboundData: Prisma.ChannelMessageCreateInput = {
        organizationId: message.organizationId,
        channelConnectionId: channel.id,
        provider: isMeta ? "META_CLOUD_API" : "TWILIO",
        direction: ChannelMessageDirection.OUTBOUND,
        status: ChannelMessageStatus.PROCESSING,
        fromAddress: isMeta ? (channel.displayPhoneNumber ?? channel.phoneNumberId ?? "") : normalizeWhatsAppAddress((channel.configuration as Record<string, unknown>)?.fromNumber as string ?? "").address,
        toAddress: message.fromAddress,
        body: responseText,
        ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
        ...(agentExecutionId ? { agentExecutionId } : {})
      } as unknown as Prisma.ChannelMessageCreateInput;
      const outbound = await this.prisma.channelMessage.create({ data: outboundData });
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

  /** Sends (or resends) an outbound row and persists the delivery/failure outcome. Supports both Twilio
   *  and Meta Cloud API providers. */
  private async sendOutbound(
    channel: { id: string; configuration: unknown; encryptedSecrets: unknown; provider?: string; phoneNumberId?: string | null; displayPhoneNumber?: string | null },
    outbound: ChannelMessage
  ): Promise<boolean> {
    const provider = channel.provider ?? "TWILIO";
    if (provider === "META_CLOUD_API") return this.sendViaMeta(channel, outbound);
    return this.sendViaTwilio(channel, outbound);
  }

  private async sendViaTwilio(
    channel: { id: string; configuration: unknown; encryptedSecrets: unknown },
    outbound: ChannelMessage
  ): Promise<boolean> {
    const configuration = (channel.configuration ?? {}) as { accountSid?: string; fromNumber?: string };
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    if (!configuration.accountSid || !configuration.fromNumber || !secrets.authToken) {
      await this.failOutbound(outbound, "CHANNEL_CREDENTIALS_REQUIRED");
      return false;
    }
    try {
      const sent = await this.twilio.sendWhatsAppMessage({
        accountSid: configuration.accountSid, authToken: secrets.authToken,
        from: configuration.fromNumber, to: outbound.toAddress, body: outbound.body ?? ""
      });
      await this.markSent(outbound, sent.providerMessageSid);
      return true;
    } catch (error) {
      const code = error instanceof TwilioProviderError ? error.code : "CHANNEL_PROVIDER_UNAVAILABLE";
      await this.failOrRetry(outbound, code);
      return false;
    }
  }

  private async sendViaMeta(
    channel: { id: string; encryptedSecrets: unknown; phoneNumberId?: string | null },
    outbound: ChannelMessage
  ): Promise<boolean> {
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const accessToken = secrets.accessToken;
    const phoneNumberId = channel.phoneNumberId;
    if (!accessToken || !phoneNumberId) {
      await this.failOutbound(outbound, "META_CREDENTIALS_REQUIRED");
      return false;
    }
    try {
      const result = await sendMetaWhatsAppText({
        phoneNumberId, accessToken, to: outbound.toAddress, text: outbound.body ?? ""
      });
      await this.markSent(outbound, result.providerMessageId);
      return true;
    } catch {
      await this.failOrRetry(outbound, "META_SEND_FAILED");
      return false;
    }
  }

  private async markSent(outbound: ChannelMessage, providerMessageSid: string): Promise<void> {
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: { status: ChannelMessageStatus.SENT, providerMessageSid, sentAt: new Date() }
    });
  }

  private async failOutbound(outbound: ChannelMessage, errorCode: string): Promise<void> {
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: { status: ChannelMessageStatus.FAILED, errorCode, nextAttemptAt: null }
    });
  }

  private async failOrRetry(outbound: ChannelMessage, errorCode: string): Promise<void> {
    const attempts = outbound.processingAttempts;
    const retryable = attempts < MAX_ATTEMPTS;
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: {
        status: ChannelMessageStatus.FAILED, errorCode,
        errorMessage: "Outbound WhatsApp delivery failed",
        nextAttemptAt: retryable ? backoff(attempts) : null
      }
    });
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
