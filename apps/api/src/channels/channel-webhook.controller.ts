import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ChannelConnectionStatus, PluginStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { ChannelMessageProcessor } from "./channel-message.processor";
import {
  normalizeInboundWhatsAppPayload,
  verifyTwilioSignature,
  WebhookRateLimiter
} from "./channel.runtime";

/**
 * Twilio-facing endpoint. Kept deliberately dumb: verify, validate, persist, trigger the
 * background processor, and return immediately — the LLM call never runs inline with this request.
 */
@ApiExcludeController()
@Controller("channels/twilio/whatsapp/webhook")
export class ChannelWebhookController {
  private readonly rateLimiter = new WebhookRateLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly processor: ChannelMessageProcessor,
    private readonly auditLogger: AuditEventLogger,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  @Post(":channelId")
  @HttpCode(HttpStatus.OK)
  async handle(
    @Param("channelId", new ParseUUIDPipe()) channelId: string,
    @Req() request: IdentityRequest & { body: Record<string, unknown> }
  ): Promise<Record<string, never>> {
    if (!this.rateLimiter.allow(channelId))
      throw new HttpException("CHANNEL_WEBHOOK_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS);

    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: channelId, provider: "TWILIO", channelType: "WHATSAPP", deletedAt: null },
      include: { pluginInstallation: true }
    });
    if (!channel) throw new NotFoundException("CHANNEL_NOT_FOUND");

    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    if (!secrets.authToken) throw new UnauthorizedException();
    const url = `${this.security.apiPublicUrl}/api/v1/channels/twilio/whatsapp/webhook/${channelId}`;
    const params = stringParams(request.body);
    if (!verifyTwilioSignature(secrets.authToken, url, params, request.header("x-twilio-signature")))
      throw new UnauthorizedException();

    if (
      channel.status !== ChannelConnectionStatus.ACTIVE ||
      channel.pluginInstallation.status !== PluginStatus.ACTIVE
    )
      throw new ConflictException("CHANNEL_UNAVAILABLE");

    let normalized;
    try {
      normalized = normalizeInboundWhatsAppPayload(request.body);
    } catch {
      throw new BadRequestException("CHANNEL_WEBHOOK_PAYLOAD_INVALID");
    }

    try {
      await this.prisma.channelMessage.create({
        data: {
          organizationId: channel.organizationId,
          channelConnectionId: channel.id,
          provider: "TWILIO",
          direction: "INBOUND",
          status: "RECEIVED",
          providerMessageSid: normalized.providerMessageSid,
          fromAddress: normalized.fromAddress,
          toAddress: normalized.toAddress,
          body: normalized.body,
          mediaMetadata: normalized.media as unknown as Prisma.InputJsonValue,
          receivedAt: new Date()
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return {};
      throw error;
    }

    this.auditLogger.record("CHANNEL_MESSAGE_RECEIVED", request.requestId, {
      organizationId: channel.organizationId,
      targetId: channel.id
    });
    this.processor.trigger();
    return {};
  }
}

function stringParams(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value)])
  );
}
