/** Sprint 7 — Twilio inbound Voice webhook. Kept deliberately thin, mirroring
 * ChannelWebhookController's shape: identify the channel, verify voice is enabled, verify the Twilio
 * signature, create-or-retrieve an idempotent VoiceSession, and return TwiML pointing Twilio at the
 * secure Media Stream WebSocket. No AI/agent execution happens on this request — that only starts once
 * the media stream connects (voice-stream.gateway.ts -> VoiceSessionEngine).
 */
import {
  BadRequestException,
  ConflictException,
  Controller,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Prisma, VoiceTransport } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { SECURITY_CONFIG, type SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { ObservabilityService } from "../observability/observability.service";
import { resolveTwilioCredentials, WebhookRateLimiter } from "../channels/channel.runtime";
import { VoiceSessionService } from "../receptionist/voice-channel.adapter";
import { resolveVoicePublicWsUrl } from "./voice-config";
import { VOICE_TRANSPORT_PROVIDER, type VoiceTransportProvider } from "./voice.types";

function stringParams(body: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : String(value)])
  );
}

@ApiExcludeController()
@Controller("channels/twilio/voice")
export class VoiceWebhookController {
  private readonly rateLimiter = new WebhookRateLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly sessions: VoiceSessionService,
    @Inject(VOICE_TRANSPORT_PROVIDER) private readonly transport: VoiceTransportProvider,
    private readonly auditLogger: AuditEventLogger,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly observability?: ObservabilityService
  ) {}

  @Post(":channelId/incoming")
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "text/xml")
  async incoming(
    @Param("channelId", new ParseUUIDPipe()) channelId: string,
    @Req() request: IdentityRequest & { body: Record<string, unknown> }
  ): Promise<string> {
    if (!this.rateLimiter.allow(channelId))
      throw new HttpException("CHANNEL_WEBHOOK_RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS);

    const channel = await this.prisma.channelConnection.findFirst({
      where: { id: channelId, provider: "TWILIO", deletedAt: null },
      include: { pluginInstallation: true }
    });
    if (!channel) throw new NotFoundException("CHANNEL_NOT_FOUND");
    if (channel.status !== "ACTIVE" || channel.pluginInstallation.status !== "ACTIVE")
      throw new ConflictException("CHANNEL_UNAVAILABLE");
    if (!channel.voiceEnabled) throw new ConflictException("VOICE_CHANNEL_DISABLED");

    const decryptedSecrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const channelConfig = channel.configuration as { accountSid?: string; fromNumber?: string } | null;
    const credentials = resolveTwilioCredentials({
      accountSid: channelConfig?.accountSid,
      authToken: decryptedSecrets.authToken,
      fromNumber: channelConfig?.fromNumber
    });
    if (!credentials) throw new UnauthorizedException();

    const requestUrl = `${this.security.apiPublicUrl}/api/v1/channels/twilio/voice/${channelId}/incoming`;
    const params = stringParams(request.body);
    const webhookRequest = { params, requestUrl, signatureHeader: request.header("x-twilio-signature") };
    if (!this.transport.validateIncomingWebhook(webhookRequest, { authToken: credentials.authToken }))
      throw new UnauthorizedException();

    let call;
    try {
      call = this.transport.parseIncomingCall(webhookRequest);
    } catch {
      throw new BadRequestException("VOICE_WEBHOOK_PAYLOAD_INVALID");
    }

    const observability = this.observability;
    const voiceSession = observability
      ? await observability.withSpan(
          null,
          {
            name: "VOICE_INBOUND_WEBHOOK",
            spanType: "CHANNEL_MESSAGE",
            component: "VoiceWebhookController",
            organizationId: channel.organizationId,
            actorType: "CHANNEL",
            inputSummary: { provider: "TWILIO", channelConnectionId: channel.id }
          },
          () => this.createOrRetrieveSession(channel, call)
        )
      : await this.createOrRetrieveSession(channel, call);

    const wsBase = resolveVoicePublicWsUrl(this.config, this.security.apiPublicUrl);
    const mediaStreamUrl = `${wsBase}/api/v1/channels/twilio/voice/stream/${voiceSession.id}`;
    const { body } = this.transport.createIncomingCallResponse({
      mediaStreamUrl,
      providerCallId: call.providerCallId
    });

    this.auditLogger.record("VOICE_CALL_STARTED", request.requestId, {
      organizationId: channel.organizationId,
      targetId: channel.id
    });
    return body;
  }

  private async createOrRetrieveSession(
    channel: { organizationId: string; id: string },
    call: { providerCallId: string; externalCallerId: string | null }
  ) {
    try {
      return await this.sessions.createRinging({
        organizationId: channel.organizationId,
        channelConnectionId: channel.id,
        provider: "TWILIO",
        providerCallId: call.providerCallId,
        // This webhook route is specifically the Twilio-WhatsApp-Business-Calling gateway; a future
        // PSTN-only route would pass VoiceTransport.PSTN instead.
        transport: VoiceTransport.WHATSAPP,
        externalCallerId: call.externalCallerId
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Twilio retried the same webhook (duplicate CallSid) — idempotent: return the existing session.
        const existing = await this.sessions.findByProviderCallId(
          channel.organizationId,
          "TWILIO",
          call.providerCallId
        );
        if (existing) return existing;
      }
      if (error instanceof Error && error.message === "RECEPTIONIST_VOICE_DISABLED")
        throw new ConflictException("VOICE_DISABLED");
      if (error instanceof Error && error.message === "VOICE_SESSION_SCOPE_INVALID")
        throw new ConflictException("VOICE_CHANNEL_UNAVAILABLE");
      throw error;
    }
  }
}
