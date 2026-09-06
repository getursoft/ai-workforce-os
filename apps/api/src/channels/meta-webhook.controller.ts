import { Controller, Get, Post, Param, Query, Headers, Body, HttpCode, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { verifyMetaWebhookSignature } from "./whatsapp/meta-whatsapp.client";
import { ChannelMessageProcessor } from "./channel-message.processor";
import { ObservabilityService } from "../observability/observability.service";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 10_000;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

@Controller("channels/whatsapp/webhook")
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly processor: ChannelMessageProcessor,
    @Optional() private readonly observability?: ObservabilityService
  ) {}

  /**
   * Meta webhook verification (GET).
   * Meta sends a GET request with hub.mode, hub.verify_token, hub.challenge.
   * We must respond with hub.challenge when verification succeeds.
   */
  @Get(":channelId")
  async verifyWebhook(
    @Param("channelId") channelId: string,
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string
  ): Promise<string> {
    if (mode !== "subscribe" || !token || !challenge) {
      throw new Error("META_WEBHOOK_VERIFICATION_FAILED");
    }
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: channelId, provider: "META_CLOUD_API", deletedAt: null }
    });
    if (!channel) throw new Error("CHANNEL_NOT_FOUND");
    const decrypted = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const storedToken = decrypted.webhookVerifyToken;
    if (!storedToken || token !== storedToken) {
      this.logger.warn({ event: "META_WEBHOOK_VERIFICATION_FAILED", channelId });
      throw new Error("META_WEBHOOK_VERIFICATION_FAILED");
    }
    await this.prisma.channelConnection.update({
      where: { id: channelId },
      data: { lastWebhookReceivedAt: new Date() }
    });
    this.logger.log({ event: "META_WEBHOOK_VERIFIED", channelId });
    return challenge;
  }

  /**
   * Meta webhook event receiver (POST).
   * Validates signature, normalises inbound messages, persists, processes.
   */
  @Post(":channelId")
  @HttpCode(200)
  async receiveWebhook(
    @Param("channelId") channelId: string,
    @Headers("x-hub-signature-256") signature: string,
    @Body() body: Record<string, unknown>
  ): Promise<Record<string, string>> {
    if (!checkRateLimit(channelId)) {
      this.logger.warn({ event: "META_WEBHOOK_RATE_LIMITED", channelId });
      return {};
    }
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: channelId, provider: "META_CLOUD_API", deletedAt: null },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    if (!channel) return {};
    if (channel.status !== "ACTIVE" && channel.status !== "CONNECTED") return {};
    if (channel.pluginInstallation.status !== "ACTIVE") return {};
    const rawBody = JSON.stringify(body);
    const decrypted = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const appSecret = decrypted.appSecret;
    if (appSecret) {
      if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
        this.logger.warn({ event: "META_WEBHOOK_SIGNATURE_INVALID", channelId });
        return {};
      }
    } else {
      // Sprint 6.7 — Part 31 security audit: an appSecret-less channel accepts an unsigned webhook body.
      // Not tightened to a hard rejection here (would break any existing channel connected without one
      // configured, a behavior change beyond this sprint's mandate) — flagged loudly instead so it's
      // visible in logs/alerting, and documented in the sprint report as a real, narrow gap.
      this.logger.warn({ event: "META_WEBHOOK_SIGNATURE_VERIFICATION_SKIPPED", channelId });
    }
    const payload = body as Record<string, unknown>;
    const entries = payload.entry as Array<Record<string, unknown>> | undefined;
    const entry = entries?.[0];
    const changes = entry?.changes as Array<Record<string, unknown>> | undefined;
    const change = changes?.[0];
    const value = change?.value as Record<string, unknown> | undefined;
    if (!value) return {};
    if (value.messaging_product !== "whatsapp") return {};
    const statuses = value.statuses as Array<Record<string, unknown>> | undefined;
    if (statuses) {
      for (const status of statuses) {
        await this.handleStatusUpdate(channelId, channel.organizationId, status);
      }
      return {};
    }
    const messages = value.messages as Array<Record<string, unknown>> | undefined;
    if (!messages) return {};
    for (const msg of messages) {
      const providerMessageId = msg.id as string | undefined;
      if (!providerMessageId) continue;
      const meta = value.metadata as Record<string, unknown> | undefined;
      const senderNumber = msg.from as string;
      const recipientNumberId = meta?.phone_number_id as string | undefined;
      if (!senderNumber || !recipientNumberId) continue;
      const textObj = msg.text as Record<string, unknown> | undefined;
      const bodyText = textObj?.body as string ?? "";
      const msgType = String(msg.type ?? "unknown");
      const webhookReceivedAt = Date.now();
      // Sprint 4.7A Phase 4: this webhook receipt is the trace's own origin (signature already verified
      // above, this is dedup+persist) — a genuine root span/trace, distinct from the background worker's
      // own later BACKGROUND_TASK span, which reattaches to the SAME traceId via rootedContext() once it
      // picks the row up (same async-continuity pattern already used for delegated task dispatch). A
      // duplicate delivery (P2002, Meta's own webhook retries) is caught and swallowed INSIDE the span so
      // it completes normally rather than being recorded as a false-positive trace failure.
      const persist = async (span?: { traceId: string; sampled: boolean }) => {
        try {
          return await this.prisma.channelMessage.create({
            data: {
              organizationId: channel.organizationId,
              channelConnectionId: channelId,
              provider: "META_CLOUD_API",
              direction: "INBOUND",
              status: "RECEIVED",
              providerMessageSid: providerMessageId,
              fromAddress: senderNumber,
              toAddress: recipientNumberId,
              body: bodyText,
              mediaMetadata: msgType !== "text" ? [{ type: msgType }] : [],
              receivedAt: new Date(),
              ...(span?.sampled ? { traceId: span.traceId } : {})
            }
          });
        } catch (error: unknown) {
          const prismaError = error as { code?: string };
          if (prismaError.code === "P2002") return null;
          this.logger.error({ event: "META_WEBHOOK_PERSIST_FAILED", channelId, providerMessageId, error: String(error) });
          return null;
        }
      };
      if (this.observability)
        await this.observability.withSpan(
          null,
          {
            name: "CHANNEL_INBOUND_WEBHOOK",
            spanType: "CHANNEL_MESSAGE",
            component: "MetaWebhookController",
            organizationId: channel.organizationId,
            actorType: "CHANNEL",
            inputSummary: { provider: "META_CLOUD_API", channelConnectionId: channelId, messageType: msgType }
          },
          async (span) => {
            const created = await persist(span);
            await this.observability?.addAttribute(span, "webhook", { firstAckMs: Date.now() - webhookReceivedAt, provider: "META_CLOUD_API", duplicate: created === null });
            return created;
          }
        );
      else await persist();
    }
    this.processor.trigger();
    return {};
  }

  /** Sprint 6.7 — monotonic status guard: every branch's `where` only matches rows in a state this
   *  transition may legally advance FROM, via a conditional `updateMany` (the same atomic-conditional-
   *  update idiom `ChannelMessageProcessor.claim()` already uses). A duplicate or out-of-order callback
   *  (Meta redelivers webhooks, "sent" can arrive after "delivered") therefore either no-ops or is ignored
   *  — DELIVERED never regresses to SENT, and a FAILED/DELIVERED row is left alone by a later callback. */
  private async handleStatusUpdate(channelId: string, _organizationId: string, status: Record<string, unknown>) {
    const providerMessageId = status.id as string;
    const statusValue = status.status as string;
    if (!providerMessageId) return;
    const errors = status.errors as Array<Record<string, unknown>> | undefined;
    const errorCode = errors?.[0]?.code != null ? String(errors[0].code) : null;
    const errorMessage = (errors?.[0]?.title as string | undefined) ?? null;
    try {
      if (statusValue === "delivered" || statusValue === "read") {
        await this.prisma.channelMessage.updateMany({
          where: {
            channelConnectionId: channelId,
            providerMessageSid: providerMessageId,
            status: { in: ["PROCESSING", "SENT"] }
          },
          data: { status: "DELIVERED" }
        });
      } else if (statusValue === "failed") {
        await this.prisma.channelMessage.updateMany({
          where: {
            channelConnectionId: channelId,
            providerMessageSid: providerMessageId,
            status: { in: ["PROCESSING", "SENT"] }
          },
          data: { status: "FAILED", errorCode, errorMessage }
        });
      } else {
        // "sent" (or any other forward-looking status) — only relevant if our own send-path hasn't
        // already marked the row SENT/DELIVERED/FAILED.
        await this.prisma.channelMessage.updateMany({
          where: { channelConnectionId: channelId, providerMessageSid: providerMessageId, status: "PROCESSING" },
          data: { status: "SENT" }
        });
      }
    } catch {
      // best-effort status update
    }
  }
}
