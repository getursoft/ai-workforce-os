/** Sprint 7.12 STEP 13/16/17/18 — determines destinations, applies channel-preference policy, avoids
 * duplicates, invokes the right provider abstraction, and persists every delivery attempt. NEVER sends
 * SMS/email/WhatsApp directly from a chat/voice controller — this is the one place that does.
 *
 * A notification failure never breaks interaction completion: every public method here swallows its own
 * errors (logs and records a FAILED/SKIPPED InteractionNotification row) rather than throwing — callers
 * invoke this fire-and-forget, strictly AFTER the interaction is already marked complete.
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Interaction, InteractionNotificationType } from "@prisma/client";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import { EmailNotConfiguredError, EmailService } from "../notifications/email.service";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { InteractionMetricsService } from "./interaction-metrics.service";
import { maskEmail, maskPhone } from "./interaction-privacy";
import { renderReferenceEmail, renderReferenceSms, renderReferenceWhatsApp } from "./notification-templates";
import { MockSmsProvider } from "./sms/mock-sms.provider";
import type { SmsProvider } from "./sms/sms-provider.types";
import { TwilioSmsProvider } from "./sms/twilio-sms.provider";
import { WHATSAPP_SENDER, type WhatsAppSender } from "./whatsapp-sender.types";

const NON_TERMINAL_NOTIFICATION_STATUSES = ["PENDING", "SENT", "DELIVERED"] as const;

@Injectable()
export class InteractionNotificationOrchestrator {
  private readonly logger = new Logger(InteractionNotificationOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly email: EmailService,
    private readonly mockSms: MockSmsProvider,
    private readonly twilioSms: TwilioSmsProvider,
    private readonly metrics: InteractionMetricsService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly channelProcessorOverride?: WhatsAppSender
  ) {}

  /** Resolved lazily via ModuleRef against the WHATSAPP_SENDER token (not the concrete
   * ChannelMessageProcessor class — see whatsapp-sender.types.ts), and not constructor DI — ChannelModule
   * transitively imports AgentModule, and AgentService optionally injects InteractionService back, so any
   * direct reference to the concrete class here (even just for typing) would recreate a circular file
   * import through AgentService. Same reasoning and pattern as
   * AgentService.getReceptionistRuntime()/getChatDelegationTrigger(). `channelProcessorOverride` exists
   * purely so unit tests can inject a mock directly without needing a real ModuleRef. */
  private getChannelMessageProcessor(): WhatsAppSender | null {
    if (this.channelProcessorOverride) return this.channelProcessorOverride;
    if (!this.moduleRef) return null;
    try {
      return this.moduleRef.get(WHATSAPP_SENDER, { strict: false });
    } catch {
      return null;
    }
  }

  private smsProvider(): SmsProvider {
    // Real Twilio SMS only when actually configured — never a fabricated credential (STEP 14/36).
    return this.twilioSms.isConfigured() ? this.twilioSms : this.mockSms;
  }

  /** STEP 13 entry point — called once, right after an Interaction is marked COMPLETED (never before).
   * Determines which channel(s) to attempt per STEP 17's policy and fires them all; each channel's
   * outcome is independent (one failing never stops the others — STEP 43). */
  async notifyReferenceIssued(organizationId: string, interactionId: string): Promise<void> {
    try {
      if (!this.config.boolean("REFERENCE_NOTIFICATION_ENABLED", true)) return;
      const interaction = await this.prisma.interaction.findFirst({
        where: { id: interactionId, organizationId }
      });
      if (!interaction) return;
      const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
      const organizationName = organization?.name ?? "our team";

      for (const type of this.channelPlan(interaction)) {
        await this.sendOne(interaction, organizationName, type);
      }
    } catch (error) {
      // Belt-and-suspenders: this method must NEVER throw into the caller (interaction completion is
      // already committed by the time this runs).
      this.logger.error({
        event: "REFERENCE_NOTIFICATION_ORCHESTRATION_FAILED",
        organizationId,
        interactionId,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  /** STEP 17 — deterministic per-origin-channel policy. Never sends every channel by default; only what
   * the interaction's own origin and known contact details justify. */
  private channelPlan(interaction: Interaction): InteractionNotificationType[] {
    const plan: InteractionNotificationType[] = [];
    const hasWhatsAppIdentity = interaction.channel === "WHATSAPP" || interaction.transport === "WHATSAPP";
    if (hasWhatsAppIdentity && interaction.externalUserId) plan.push("WHATSAPP");
    else if (interaction.phoneNumber) plan.push("SMS");
    if (interaction.email) plan.push("EMAIL");
    return plan;
  }

  private async sendOne(
    interaction: Interaction,
    organizationName: string,
    type: InteractionNotificationType
  ): Promise<void> {
    const existing = await this.prisma.interactionNotification.findFirst({
      where: { interactionId: interaction.id, type, status: { in: [...NON_TERMINAL_NOTIFICATION_STATUSES] } }
    });
    if (existing) return; // STEP 31 — never send the same reference through the same channel twice.

    this.metrics.increment("reference_notifications_requested_total");
    const destination = type === "EMAIL" ? interaction.email : interaction.phoneNumber ?? interaction.externalUserId;
    if (!destination) {
      await this.recordSkipped(interaction, type, "NO_DESTINATION");
      return;
    }
    const record = await this.prisma.interactionNotification.create({
      data: {
        interactionId: interaction.id,
        organizationId: interaction.organizationId,
        type,
        destinationMasked: type === "EMAIL" ? maskEmail(destination) : maskPhone(destination),
        provider: this.providerNameFor(type),
        status: "PENDING"
      }
    });

    try {
      if (type === "EMAIL") await this.sendEmail(interaction, organizationName, destination, record.id);
      else if (type === "SMS") await this.sendSms(interaction, organizationName, destination, record.id);
      else await this.sendWhatsApp(interaction, record.id);
    } catch (error) {
      await this.markFailed(record.id, "REFERENCE_NOTIFICATION_UNEXPECTED_ERROR");
      this.logger.error({
        event: "REFERENCE_NOTIFICATION_FAILED",
        organizationId: interaction.organizationId,
        interactionId: interaction.id,
        notificationId: record.id,
        notificationType: type,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  private providerNameFor(type: InteractionNotificationType): string {
    if (type === "EMAIL") return "smtp";
    if (type === "SMS") return this.smsProvider().name;
    return "whatsapp";
  }

  private async sendEmail(
    interaction: Interaction,
    organizationName: string,
    to: string,
    notificationId: string
  ): Promise<void> {
    if (!this.config.boolean("REFERENCE_EMAIL_ENABLED", true)) {
      await this.markSkipped(notificationId, "EMAIL_CHANNEL_DISABLED");
      return;
    }
    const { subject, text } = renderReferenceEmail({
      referenceId: interaction.referenceId,
      organizationName
    });
    try {
      const result = await this.email.sendMail({ to, subject, text });
      await this.markSent(notificationId, result.messageId);
      this.logNotificationSent(interaction, "EMAIL", notificationId);
    } catch (error) {
      const code = error instanceof EmailNotConfiguredError ? "EMAIL_NOT_CONFIGURED" : "EMAIL_SEND_FAILED";
      await this.markFailed(notificationId, code);
      this.logNotificationFailed(interaction, "EMAIL", notificationId, code);
    }
  }

  private async sendSms(
    interaction: Interaction,
    organizationName: string,
    to: string,
    notificationId: string
  ): Promise<void> {
    if (!this.config.boolean("REFERENCE_SMS_ENABLED", true)) {
      await this.markSkipped(notificationId, "SMS_CHANNEL_DISABLED");
      return;
    }
    const provider = this.smsProvider();
    const message = renderReferenceSms({ referenceId: interaction.referenceId, organizationName });
    let result = await provider.send({ to, message });
    if (result.status === "FAILED" && result.retryable) {
      // STEP 32: retry only transient errors, and only once — this is a synchronous immediate retry, not
      // a scheduled backoff job (see docs/interaction-reference.md's documented limitation).
      result = await provider.send({ to, message });
    }
    if (result.status === "SENT") {
      await this.markSent(notificationId, result.messageId);
      this.logNotificationSent(interaction, "SMS", notificationId);
    } else {
      await this.markFailed(notificationId, result.error ?? "SMS_SEND_FAILED");
      this.logNotificationFailed(interaction, "SMS", notificationId, result.error ?? "SMS_SEND_FAILED");
    }
  }

  /** STEP 16 — reuses the EXISTING WhatsApp outbound pipeline (ChannelMessageProcessor.sendHumanMessage,
   * the same one Sprint 6.7's human-takeover replies go through) rather than a second Twilio/Meta
   * implementation. This also means WhatsApp reference messages get the real retry/attempt-history
   * pipeline that channel already has, unlike the synchronous email/SMS sends above. */
  private async sendWhatsApp(interaction: Interaction, notificationId: string): Promise<void> {
    if (!this.config.boolean("REFERENCE_WHATSAPP_ENABLED", true)) {
      await this.markSkipped(notificationId, "WHATSAPP_CHANNEL_DISABLED");
      return;
    }
    if (!interaction.conversationId) {
      await this.markSkipped(notificationId, "NO_CONVERSATION_FOR_WHATSAPP");
      return;
    }
    const channelProcessor = this.getChannelMessageProcessor();
    if (!channelProcessor) {
      await this.markSkipped(notificationId, "CHANNEL_PROCESSOR_UNAVAILABLE");
      return;
    }
    const message = renderReferenceWhatsApp({ referenceId: interaction.referenceId, organizationName: "" });
    const { delivered, channelMessageId } = await channelProcessor.sendHumanMessage(
      interaction.organizationId,
      interaction.conversationId,
      message
    );
    if (delivered) {
      await this.markSent(notificationId, channelMessageId);
      this.logNotificationSent(interaction, "WHATSAPP", notificationId);
    } else {
      await this.markFailed(notificationId, "WHATSAPP_SEND_FAILED");
      this.logNotificationFailed(interaction, "WHATSAPP", notificationId, "WHATSAPP_SEND_FAILED");
    }
  }

  private async markSent(notificationId: string, providerMessageId: string | null): Promise<void> {
    await this.prisma.interactionNotification.update({
      where: { id: notificationId },
      data: { status: "SENT", sentAt: new Date(), providerMessageId }
    });
    this.metrics.increment("reference_notifications_sent_total");
  }

  private async markFailed(notificationId: string, failureReason: string): Promise<void> {
    await this.prisma.interactionNotification.update({
      where: { id: notificationId },
      data: { status: "FAILED", failureReason }
    });
    this.metrics.increment("reference_notifications_failed_total");
  }

  private async markSkipped(notificationId: string, failureReason: string): Promise<void> {
    await this.prisma.interactionNotification.update({
      where: { id: notificationId },
      data: { status: "SKIPPED", failureReason }
    });
  }

  private async recordSkipped(
    interaction: Interaction,
    type: InteractionNotificationType,
    failureReason: string
  ): Promise<void> {
    await this.prisma.interactionNotification.create({
      data: {
        interactionId: interaction.id,
        organizationId: interaction.organizationId,
        type,
        destinationMasked: "",
        provider: this.providerNameFor(type),
        status: "SKIPPED",
        failureReason
      }
    });
  }

  private logNotificationSent(interaction: Interaction, type: InteractionNotificationType, notificationId: string) {
    this.logger.log({
      event: "REFERENCE_NOTIFICATION_SENT",
      organizationId: interaction.organizationId,
      interactionId: interaction.id,
      referenceId: interaction.referenceId,
      notificationId,
      notificationType: type
    });
  }

  private logNotificationFailed(
    interaction: Interaction,
    type: InteractionNotificationType,
    notificationId: string,
    errorCode: string
  ) {
    this.logger.warn({
      event: "REFERENCE_NOTIFICATION_FAILED",
      organizationId: interaction.organizationId,
      interactionId: interaction.id,
      notificationId,
      notificationType: type,
      errorCode
    });
  }
}
