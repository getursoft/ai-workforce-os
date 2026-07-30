import { Controller, Get, Post, Param, Query, Headers, Body, HttpCode, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { verifyMetaWebhookSignature } from "./whatsapp/meta-whatsapp.client";
import { ChannelMessageProcessor } from "./channel-message.processor";

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
    private readonly processor: ChannelMessageProcessor
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
    if (appSecret && !verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
      this.logger.warn({ event: "META_WEBHOOK_SIGNATURE_INVALID", channelId });
      return {};
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
      try {
        await this.prisma.channelMessage.create({
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
            receivedAt: new Date()
          }
        });
      } catch (error: unknown) {
        const prismaError = error as { code?: string };
        if (prismaError.code === "P2002") continue;
        this.logger.error({ event: "META_WEBHOOK_PERSIST_FAILED", channelId, providerMessageId, error: String(error) });
        continue;
      }
    }
    this.processor.trigger();
    return {};
  }

  private async handleStatusUpdate(channelId: string, _organizationId: string, status: Record<string, unknown>) {
    const providerMessageId = status.id as string;
    const statusValue = status.status as string;
    if (!providerMessageId) return;
    const errors = status.errors as Array<Record<string, unknown>> | undefined;
    try {
      await this.prisma.channelMessage.updateMany({
        where: { channelConnectionId: channelId, providerMessageSid: providerMessageId },
        data: { status: statusValue === "read" ? "SENT" : statusValue === "failed" ? "FAILED" : "SENT", errorCode: errors?.[0]?.code as string ?? null, errorMessage: errors?.[0]?.title as string ?? null }
      });
    } catch {
      // best-effort status update
    }
  }
}
