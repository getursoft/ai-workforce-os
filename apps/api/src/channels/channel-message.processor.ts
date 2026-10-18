import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional
} from "@nestjs/common";
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
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { AgentService } from "../agents/agent.service";
import type { AgentExecutionInput, ChannelContact } from "../agents/agent.runtime";
import { ObservabilityService } from "../observability/observability.service";
import { rootedContext, type TraceContext } from "../observability/trace-context";
import {
  classifyProviderError,
  normalizeWhatsAppAddress,
  resolveTwilioCredentials,
  TwilioClient,
  TwilioProviderError
} from "./channel.runtime";
import { MetaProviderError, sendMetaWhatsAppText } from "./whatsapp/meta-whatsapp.client";
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
  /** Sprint 4.7A Phase 7: last poll-tick timestamp, read by ObservabilityHealthService's "Background
   *  Worker" check — a stale value means the interval stopped ticking (crash, event-loop stall), not just
   *  that there was no work to do. */
  private lastPollAt: Date | null = null;

  getLastPollAt(): Date | null {
    return this.lastPollAt;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly auditLogger: AuditEventLogger,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Optional() private readonly employeeRouter?: EmployeeRouterService,
    @Optional() private readonly observability?: ObservabilityService,
    @Optional() @Inject(APP_CONFIG) private readonly appConfig?: AppConfig
  ) {}

  /** Sprint 4.7A Phase 4: reattaches to the trace the webhook controller started (persisted as a plain
   *  traceId column, same async-continuity pattern as EmployeeDelegatedTask.traceId — see trace-context.ts).
   *  Runs `fn` inside a BACKGROUND_TASK span when a traceId exists and observability is available;
   *  otherwise degrades to a plain passthrough (e.g. a message with no traceId, or observability disabled). */
  private async tracedBackground<T>(
    message: ChannelMessage,
    name: string,
    fn: (span: TraceContext | undefined) => Promise<T>
  ): Promise<T> {
    if (!message.traceId || !this.observability) return fn(undefined);
    const context = rootedContext(message.organizationId, message.traceId, true, {});
    return this.observability.withSpan(
      context,
      {
        name,
        spanType: "BACKGROUND_TASK",
        component: "ChannelMessageProcessor",
        inputSummary: {
          channelConnectionId: message.channelConnectionId,
          direction: message.direction
        }
      },
      fn
    );
  }

  onModuleInit() {
    if (this.security.nodeEnvironment === "test") return;
    if (this.appConfig && !this.appConfig.runs("channel-worker")) return; // Phase 3: role separation
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

  /** Sprint 6.7 — Part 25: a human operator's reply (see `HumanTakeoverService.sendAsHuman`) is delivered
   *  through this SAME outbound `ChannelMessage` + `sendOutbound` pipeline as an AI-authored reply — not a
   *  parallel send path — so it gets identical delivery status, retry, and attempt-history guarantees.
   *  Returns `{ delivered: false, channelMessageId: null }` (never throws) when the conversation isn't
   *  channel-bound (e.g. a dashboard-only conversation) — the message is still stored via
   *  `ConversationMessage`, there's simply no WhatsApp channel to deliver it through. */
  async sendHumanMessage(
    organizationId: string,
    conversationId: string,
    body: string
  ): Promise<{ delivered: boolean; channelMessageId: string | null }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null }
    });
    if (!conversation?.channelConnectionId || !conversation.externalUserId)
      return { delivered: false, channelMessageId: null };
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: conversation.channelConnectionId, organizationId, deletedAt: null }
    });
    if (!channel || channel.status !== ChannelConnectionStatus.ACTIVE)
      return { delivered: false, channelMessageId: null };
    const isMeta = channel.provider === "META_CLOUD_API";
    const outbound = await this.prisma.channelMessage.create({
      data: {
        organizationId,
        channelConnectionId: channel.id,
        conversationId,
        provider: isMeta ? "META_CLOUD_API" : "TWILIO",
        direction: ChannelMessageDirection.OUTBOUND,
        status: ChannelMessageStatus.PROCESSING,
        fromAddress: isMeta
          ? (channel.displayPhoneNumber ?? channel.phoneNumberId ?? "")
          : normalizeWhatsAppAddress(
              ((channel.configuration as Record<string, unknown>)?.fromNumber as string) ?? ""
            ).address,
        toAddress: normalizeWhatsAppAddress(conversation.externalUserId).address,
        body
      } as unknown as Prisma.ChannelMessageCreateInput
    });
    const delivered = await this.sendOutbound(channel, outbound);
    return { delivered, channelMessageId: outbound.id };
  }

  async processOnce(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.lastPollAt = new Date();
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
    // Sprint 6.7 — per-conversation ordering (not a global lock): an INBOUND row is only offered as a
    // candidate if no OTHER inbound row for the same external identity (channelConnectionId+fromAddress)
    // is already PROCESSING and non-stale. Prevents two "book it" messages for the same conversation from
    // being claimed by two different worker processes concurrently. Best-effort (a small race window
    // remains between this read and `claim()`'s own atomic update) — the real correctness guarantee for
    // irreversible actions is the check-then-transition guard inside TravelBookingService, not this filter.
    const busyIdentities =
      direction === "INBOUND"
        ? await this.prisma.channelMessage.findMany({
            where: {
              direction: ChannelMessageDirection.INBOUND,
              status: ChannelMessageStatus.PROCESSING,
              updatedAt: { gt: stale }
            },
            select: { channelConnectionId: true, fromAddress: true },
            distinct: ["channelConnectionId", "fromAddress"]
          })
        : [];
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
        ],
        ...(busyIdentities.length
          ? {
              NOT: busyIdentities.map(({ channelConnectionId, fromAddress }) => ({
                channelConnectionId,
                fromAddress
              }))
            }
          : {})
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
    return this.tracedBackground(message, "CHANNEL_INBOUND_PROCESSING", (span) =>
      this.handleInboundTraced(message, span)
    );
  }

  /** Phase 5.3 — background worker suspension audit. This processor runs on its own setInterval tick,
   * triggered by an inbound provider webhook or a scheduled retry — no HTTP request from the tenant's own
   * user, no JwtAccessGuard, no per-user authorization context at all, only the ChannelMessage row's own
   * organizationId. A message queued (or a retry scheduled) before the organization was suspended must
   * not still run an AI agent against live tenant data or send a real outbound WhatsApp/email message
   * afterward. Terminal, not deferred — unlike resume parsing, leaving a customer's inbound message
   * unanswered until some future reactivation is worse than a clean immediate failure. */
  private async isOrganizationActive(organizationId: string): Promise<boolean> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { status: true }
    });
    return organization?.status === "ACTIVE";
  }

  private async handleInboundTraced(message: ChannelMessage, span?: TraceContext): Promise<void> {
    const processingStartedAt = Date.now();
    try {
      if (!(await this.isOrganizationActive(message.organizationId))) {
        await this.terminateInbound(message, "ORGANIZATION_SUSPENDED");
        this.audit(message.organizationId, message.channelConnectionId, "CHANNEL_MESSAGE_FAILED");
        return;
      }
      const channel = await this.prisma.channelConnection.findFirst({
        where: {
          id: message.channelConnectionId,
          organizationId: message.organizationId,
          deletedAt: null
        },
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

      // Sprint 6.7 — crash-safety resume: `computedResponseText` is only ever written AFTER the AI turn
      // (or routing decision) has fully finished, in the same atomic update that also records
      // agentExecutionId/conversationId (below). A stale-`PROCESSING` reclaim of THIS row therefore means
      // a prior attempt already produced the answer and crashed only before/during delivery — resume
      // straight to outbound composition instead of calling `agents.execute()` a second time (which would
      // risk a duplicate booking, a duplicate PDF, or a duplicate outbound message).
      const alreadyExecuted = message.computedResponseText != null;

      const externalUserId = normalizeWhatsAppAddress(message.fromAddress).externalUserId;
      let agentId = channel.pluginInstallationId;
      let conversationId = message.conversationId ?? undefined;
      let routingResponseText: string | null = null;
      const isReceptionist = manifestCapabilities(channel.pluginInstallation.manifest).includes(
        "workforce.intake"
      );

      if (!alreadyExecuted && !conversationId) {
        const prevConvo = await this.prisma.conversation.findFirst({
          where: {
            organizationId: message.organizationId,
            channelConnectionId: channel.id,
            externalUserId,
            status: "ACTIVE",
            deletedAt: null
          },
          orderBy: { updatedAt: "desc" }
        });
        if (prevConvo) conversationId = prevConvo.id;
      }

      let result: {
        conversationId: string;
        executionId: string | null;
        response: string;
        attachments?: unknown[];
        aiPaused?: boolean;
      } | null = null;
      let responseText: string;
      let responseAttachments: unknown[] | null;

      if (alreadyExecuted) {
        responseText = message.computedResponseText ?? "";
        responseAttachments = Array.isArray(message.computedResponseAttachments)
          ? (message.computedResponseAttachments as unknown[])
          : null;
      } else {
      if (channel.routingMode === "INTENT_ROUTER" && this.employeeRouter && !isReceptionist) {
        let conversation = await this.prisma.conversation.findFirst({
          where: {
            organizationId: message.organizationId,
            channelConnectionId: channel.id,
            externalUserId,
            status: "ACTIVE",
            deletedAt: null
          },
          orderBy: { updatedAt: "desc" }
        });
        const convMeta = conversation?.metadata as Record<string, unknown> | undefined;
        const routingState = convMeta?.routingState as ConversationRoutingState | undefined;

        if (!conversation || routingState?.routingStatus === "AWAITING_INTENT") {
          if (!conversation) {
            conversation = await this.prisma.conversation.create({
              data: {
                organizationId: message.organizationId,
                pluginInstallationId: channel.pluginInstallationId,
                channelConnectionId: channel.id,
                externalUserId,
                title: externalUserId,
                metadata: {
                  routingState: {
                    routingStatus: "AWAITING_INTENT",
                    selectedEmployeeId: null,
                    detectedIntent: null,
                    routingConfidence: 0,
                    routedAt: null,
                    lastRoutedAt: null,
                    clarificationCount: 0
                  }
                }
              }
            });
          }
          if (this.employeeRouter.isGreeting(message.body)) {
            routingResponseText = this.employeeRouter.buildReceptionistGreeting(channel);
            conversationId = conversation.id;
          } else {
            const routeResult = await this.employeeRouter.route(
              message.body,
              message.organizationId,
              channel,
              routingState ?? null
            );
            if (
              routeResult.decision.status === "ROUTED" &&
              routeResult.decision.employeeInstallationId
            ) {
              agentId = routeResult.decision.employeeInstallationId;
              conversationId = conversation.id;
              await this.prisma.conversation.update({
                where: { id: conversation.id },
                data: {
                  metadata: {
                    routingState: {
                      routingStatus: "ROUTED",
                      selectedEmployeeId: agentId,
                      detectedIntent: routeResult.decision.detectedIntent ?? null,
                      routingConfidence: routeResult.decision.confidence,
                      routedAt: new Date().toISOString(),
                      lastRoutedAt: new Date().toISOString(),
                      clarificationCount: routingState?.clarificationCount ?? 0
                    }
                  }
                }
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

      const channelContact =
        channel.provider === "META_CLOUD_API"
          ? ({
              channel: "WHATSAPP" as const,
              provider: "META_CLOUD_API",
              senderPhoneNumber: externalUserId,
              senderWhatsAppId: externalUserId,
              verificationSource: "PROVIDER" as const,
              verified: true as const,
              channelConnectionId: channel.id,
              organizationId: message.organizationId
            } as ChannelContact)
          : undefined;

      responseText = routingResponseText ?? "";
      if (!routingResponseText) {
        const ackEnabled =
          !isReceptionist &&
          channel.routingMode === "INTENT_ROUTER" &&
          channel.processingAcknowledgementEnabled !== false &&
          channel.processingAcknowledgementMode !== "DISABLED";
        if (ackEnabled) {
          const ackMsg =
            channel.processingAcknowledgementMessage ?? DEFAULT_ACKNOWLEDGEMENT_MESSAGE;
          await this.prisma.channelMessage.create({
            data: {
              organizationId: message.organizationId,
              channelConnectionId: channel.id,
              conversationId: conversationId ?? null,
              provider: channel.provider,
              direction: ChannelMessageDirection.OUTBOUND,
              status: ChannelMessageStatus.SENT,
              fromAddress: channel.displayPhoneNumber ?? channel.phoneNumberId ?? "",
              toAddress: message.fromAddress,
              body: ackMsg
            } as unknown as Prisma.ChannelMessageCreateInput
          });
          await this.sendOutbound(
            channel as Parameters<typeof this.sendOutbound>[0],
            {
              id: `ack-${message.id}`,
              toAddress: message.fromAddress,
              body: ackMsg,
              provider: channel.provider
            } as Parameters<typeof this.sendOutbound>[1]
          );
        }
        try {
          result = await this.agents.execute(
            Object.assign(
              {
                organizationId: message.organizationId,
                agentId,
                actor: {
                  type: "CHANNEL" as const,
                  channelConnectionId: channel.id,
                  externalUserId
                },
                text: message.body,
                source: { type: "CHANNEL" as const, channelId: channel.id, externalUserId },
                requestId: message.id,
                metadata: { channelMessageId: message.id }
              },
              conversationId ? { conversationId } : {},
              channelContact ? { channelContact } : {},
              span ? { traceContext: span } : {}
            ) as AgentExecutionInput
          );
          responseText = result?.response ?? "";
        } catch {
          responseText = DEFAULT_FAILURE_MESSAGE;
        }
        if (ackEnabled && !responseText) responseText = DEFAULT_FAILURE_MESSAGE;
      }
      responseAttachments = Array.isArray(result?.attachments) ? (result.attachments as unknown[]) : null;
      } // end !alreadyExecuted
      const resolvedConversationId = alreadyExecuted
        ? (message.conversationId ?? undefined)
        : (result?.conversationId ?? conversationId);
      const agentExecutionId = alreadyExecuted ? (message.agentExecutionId ?? undefined) : result?.executionId;

      // Sprint 6.7 — durable checkpoint: written BEFORE any outbound send is attempted, so a crash after
      // this point resumes via `alreadyExecuted` above instead of re-running `agents.execute()`. Skipped
      // entirely when already resuming (there is nothing new to persist).
      if (!alreadyExecuted) {
        const checkpointData: Record<string, unknown> = { computedResponseText: responseText };
        if (resolvedConversationId) checkpointData.conversationId = resolvedConversationId;
        if (agentExecutionId) checkpointData.agentExecutionId = agentExecutionId;
        if (responseAttachments) checkpointData.computedResponseAttachments = responseAttachments;
        await this.prisma.channelMessage.update({
          where: { id: message.id },
          data: checkpointData as unknown as Prisma.ChannelMessageUpdateInput
        });
      }

      // Sprint 6.7 — human takeover: `AgentService.execute()` returns an empty response (no
      // `agents.execute` call at all, or `aiPaused: true`) when a conversation is HUMAN_ACTIVE, or when a
      // customer's inbound message has just been stored during an active takeover. No outbound message is
      // ever created in that case — the customer's message is durably stored (already done above, via the
      // USER ConversationMessage row) and simply awaits a human reply, which goes through the SAME
      // ChannelMessage outbound pipeline via `HumanTakeoverService.sendAsHuman` once an operator responds.
      if (!responseText.trim()) {
        const finalizeData: Record<string, unknown> = { status: ChannelMessageStatus.SENT };
        if (resolvedConversationId) finalizeData.conversationId = resolvedConversationId;
        await this.prisma.channelMessage.update({ where: { id: message.id }, data: finalizeData });
        this.audit(message.organizationId, channel.id, "CHANNEL_MESSAGE_AI_PAUSED");
        return;
      }

      const isMeta = channel.provider === "META_CLOUD_API";
      const outboundData: Prisma.ChannelMessageCreateInput = {
        organizationId: message.organizationId,
        channelConnectionId: channel.id,
        provider: isMeta ? "META_CLOUD_API" : "TWILIO",
        direction: ChannelMessageDirection.OUTBOUND,
        status: ChannelMessageStatus.PROCESSING,
        fromAddress: isMeta
          ? (channel.displayPhoneNumber ?? channel.phoneNumberId ?? "")
          : normalizeWhatsAppAddress(
              ((channel.configuration as Record<string, unknown>)?.fromNumber as string) ?? ""
            ).address,
        toAddress: message.fromAddress,
        body: responseText,
        ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
        ...(agentExecutionId ? { agentExecutionId } : {}),
        ...(message.traceId ? { traceId: message.traceId } : {})
      } as unknown as Prisma.ChannelMessageCreateInput;
      const outbound = await this.prisma.channelMessage.create({ data: outboundData });
      const deliveryStartedAt = Date.now();
      const observability = this.observability;
      const delivered =
        span && observability
          ? await observability.withSpan(
              span,
              {
                name: "CHANNEL_OUTBOUND_DELIVERY",
                spanType: "MESSAGE_DELIVERY",
                component: "ChannelMessageProcessor",
                inputSummary: { provider: outboundData.provider }
              },
              async (deliverySpan) => {
                const sent = await this.sendOutbound(channel, outbound);
                await observability.addAttribute(deliverySpan, "delivery", {
                  deliveryMs: Date.now() - deliveryStartedAt,
                  delivered: sent,
                  provider: outboundData.provider
                });
                return sent;
              }
            )
          : await this.sendOutbound(channel, outbound);
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: { status: ChannelMessageStatus.SENT }
      });
      this.audit(
        message.organizationId,
        channel.id,
        delivered ? "CHANNEL_MESSAGE_SENT" : "CHANNEL_MESSAGE_FAILED"
      );
      if (span)
        await this.observability?.addAttribute(span, "pipeline", {
          processingMs: Date.now() - processingStartedAt,
          totalMs: Date.now() - message.createdAt.getTime(),
          delivered
        });
    } catch (error) {
      const code = safeCode(error);
      this.logger.warn({ event: "CHANNEL_INBOUND_PROCESSING_FAILED", messageId: message.id, code });
      if (span && this.observability)
        await this.observability.recordError(span, code, "Channel inbound processing failed");
      await this.retryOrFailInbound(message, code);
      this.audit(message.organizationId, message.channelConnectionId, "CHANNEL_MESSAGE_FAILED");
    }
  }

  private async handleOutboundRetry(message: ChannelMessage): Promise<void> {
    if (!(await this.isOrganizationActive(message.organizationId))) {
      // Not failOutbound(): that routes the code through classifyProviderError, which collapses any
      // code it doesn't recognize to "UNKNOWN" — correct for a genuine provider error, wrong here, since
      // this isn't a provider failure at all and the specific reason should stay auditable verbatim.
      await this.recordDeliveryAttempt(message, false, { errorCode: "ORGANIZATION_SUSPENDED", retryable: false });
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: { status: ChannelMessageStatus.FAILED, errorCode: "ORGANIZATION_SUSPENDED", nextAttemptAt: null }
      });
      return;
    }
    const channel = await this.prisma.channelConnection.findFirst({
      where: {
        id: message.channelConnectionId,
        organizationId: message.organizationId,
        deletedAt: null
      }
    });
    if (!channel) {
      await this.prisma.channelMessage.update({
        where: { id: message.id },
        data: {
          status: ChannelMessageStatus.FAILED,
          errorCode: "CHANNEL_UNAVAILABLE",
          nextAttemptAt: null
        }
      });
      return;
    }
    await this.sendOutbound(channel, message);
  }

  /** Sends (or resends) an outbound row and persists the delivery/failure outcome. Supports both Twilio
   *  and Meta Cloud API providers. */
  private async sendOutbound(
    channel: {
      id: string;
      configuration: unknown;
      encryptedSecrets: unknown;
      provider?: string;
      phoneNumberId?: string | null;
      displayPhoneNumber?: string | null;
    },
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
    const configuration = (channel.configuration ?? {}) as {
      accountSid?: string;
      fromNumber?: string;
    };
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const credentials = resolveTwilioCredentials({
      accountSid: configuration.accountSid,
      authToken: secrets.authToken,
      fromNumber: configuration.fromNumber
    });
    if (!credentials) {
      await this.failOutbound(outbound, "CHANNEL_CREDENTIALS_REQUIRED");
      return false;
    }
    try {
      const sent = await this.twilio.sendWhatsAppMessage({
        accountSid: credentials.accountSid,
        authToken: credentials.authToken,
        from: credentials.fromNumber,
        to: outbound.toAddress,
        body: outbound.body ?? ""
      });
      await this.markSent(outbound, sent.providerMessageSid);
      return true;
    } catch (error) {
      const code =
        error instanceof TwilioProviderError ? error.code : "CHANNEL_PROVIDER_UNAVAILABLE";
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
        phoneNumberId,
        accessToken,
        to: outbound.toAddress,
        text: outbound.body ?? ""
      });
      await this.markSent(outbound, result.providerMessageId);
      return true;
    } catch (error) {
      const code = error instanceof MetaProviderError ? error.code : "META_PROVIDER_UNAVAILABLE";
      await this.failOrRetry(outbound, code);
      return false;
    }
  }

  /** Sprint 6.7 — one row per send attempt (success or failure), independent of the parent row's own
   *  cheap "current status" summary fields. Never stores secrets/tokens — only the normalized outcome. */
  private async recordDeliveryAttempt(
    outbound: ChannelMessage,
    success: boolean,
    options: {
      providerRequestId?: string;
      errorCode?: string;
      errorMessage?: string;
      retryable?: boolean;
    } = {}
  ): Promise<void> {
    try {
      const attemptNumber =
        (await this.prisma.channelDeliveryAttempt.count({
          where: { channelMessageId: outbound.id }
        })) + 1;
      await this.prisma.channelDeliveryAttempt.create({
        data: {
          organizationId: outbound.organizationId,
          channelMessageId: outbound.id,
          attemptNumber,
          provider: outbound.provider,
          success,
          providerRequestId: options.providerRequestId ?? null,
          errorCode: options.errorCode ?? null,
          errorMessage: options.errorMessage ? options.errorMessage.slice(0, 500) : null,
          retryable: options.retryable ?? false
        }
      });
    } catch (error) {
      // Attempt-history recording is diagnostic, never load-bearing — a failure here must never block the
      // actual delivery outcome (status update, retry scheduling) from being persisted.
      this.logger.warn({ event: "CHANNEL_DELIVERY_ATTEMPT_RECORD_FAILED", code: safeCode(error) });
    }
  }

  private async markSent(outbound: ChannelMessage, providerMessageSid: string): Promise<void> {
    await this.recordDeliveryAttempt(outbound, true, { providerRequestId: providerMessageSid });
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: { status: ChannelMessageStatus.SENT, providerMessageSid, sentAt: new Date() }
    });
  }

  private async failOutbound(outbound: ChannelMessage, errorCode: string): Promise<void> {
    const { normalized } = classifyProviderError(errorCode);
    await this.recordDeliveryAttempt(outbound, false, { errorCode: normalized, retryable: false });
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: { status: ChannelMessageStatus.FAILED, errorCode: normalized, nextAttemptAt: null }
    });
  }

  private async failOrRetry(outbound: ChannelMessage, errorCode: string): Promise<void> {
    const attempts = outbound.processingAttempts;
    const classification = classifyProviderError(errorCode);
    const retryable = classification.retryable && attempts < MAX_ATTEMPTS;
    await this.recordDeliveryAttempt(outbound, false, {
      errorCode: classification.normalized,
      errorMessage: "Outbound WhatsApp delivery failed",
      retryable
    });
    await this.prisma.channelMessage.update({
      where: { id: outbound.id },
      data: {
        status: ChannelMessageStatus.FAILED,
        errorCode: classification.normalized,
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
    this.auditLogger.record(event, "channel-processor", {
      organizationId,
      targetId: channelConnectionId
    });
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

function manifestCapabilities(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const capabilities = (value as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities)
    ? capabilities.filter((item): item is string => typeof item === "string")
    : [];
}
