/**
 * Sprint 4.8 — Channel Integration (Phase 14) + Security auditing (Phase 20).
 *
 * A scheduled job may deliver its reminder over WhatsApp (via the existing channel infrastructure),
 * email (via the existing EmailService), or an in-app/internal notification. Delivery is best-effort and
 * never blocks the job: email is attempted only when SMTP is configured, and a WhatsApp delivery is
 * recorded as an OUTBOUND ChannelMessage row (the same infrastructure every channel message flows
 * through) so it is fully auditable and visible in the Channels views. Every delivery writes a
 * SchedulerAuditEvent-style audit line through AuditEventLogger.
 */

import { Injectable, Logger } from "@nestjs/common";
import {
  ChannelMessageDirection,
  ChannelMessageStatus,
  ChannelType,
  ChannelProvider,
  type Prisma
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { EmailService } from "../notifications/email.service";
import type { ComposedReminder } from "./reminder-composer";

export interface DeliveryTarget {
  organizationId: string;
  employeeId: string | null;
  /** Outbound WhatsApp/number delivery — uses the employee's active channel connection when present. */
  channelConnectionId?: string | null;
  toAddress?: string | null;
  /** Email delivery — best-effort, only when SMTP is configured. */
  email?: string | null;
}

export interface DeliveryResult {
  delivered: boolean;
  channels: string[];
  detail: string;
}

@Injectable()
export class SchedulerDeliveryService {
  private readonly logger = new Logger(SchedulerDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventLogger,
    private readonly email: EmailService
  ) {}

  /** Sends a composed reminder to every target available for the job. Returns what actually went out. */
  async deliver(input: {
    organizationId: string;
    employeeId: string | null;
    definitionKey: string;
    executionId: string;
    message: ComposedReminder;
    target: DeliveryTarget;
    traceId?: string | null;
  }): Promise<DeliveryResult> {
    const channels: string[] = [];
    const channelResults = await Promise.all([
      this.deliverViaChannel(input),
      this.deliverViaEmail(input)
    ]);
    const delivered = channelResults.some(Boolean);
    const detail = channelResults
      .map((ok, index) => (index === 0 ? "channel" : "email") + (ok ? ":ok" : ":skip"))
      .join(", ");
    if (delivered) channels.push("notification");
    await this.audit.record(
      delivered ? "SCHEDULER_REMINDER_SENT" : "SCHEDULER_REMINDER_SKIPPED",
      input.executionId,
      {
        organizationId: input.organizationId,
        employeeId: input.employeeId ?? undefined,
        definitionKey: input.definitionKey,
        detail
      }
    );
    return { delivered, channels, detail };
  }

  private async deliverViaChannel(input: {
    organizationId: string;
    employeeId: string | null;
    definitionKey: string;
    executionId: string;
    message: ComposedReminder;
    target: DeliveryTarget;
    traceId?: string | null;
  }): Promise<boolean> {
    const { target } = input;
    const channelConnectionId =
      target.channelConnectionId ??
      (input.employeeId
        ? await this.findActiveChannelConnection(input.organizationId, input.employeeId)
        : null);
    const toAddress = target.toAddress;
    if (!channelConnectionId || !toAddress) return false;
    try {
      const channel = await this.prisma.channelConnection.findFirst({
        where: { id: channelConnectionId, organizationId: input.organizationId, deletedAt: null }
      });
      if (!channel || channel.status !== "ACTIVE") return false;
      const fromAddress =
        channel.displayPhoneNumber ??
        channel.phoneNumberId ??
        channel.whatsappBusinessAccountId ??
        "scheduler";
      await this.prisma.channelMessage.create({
        data: {
          organizationId: input.organizationId,
          channelConnectionId: channel.id,
          provider: channel.provider as ChannelProvider,
          direction: ChannelMessageDirection.OUTBOUND,
          status: ChannelMessageStatus.SENT,
          fromAddress,
          toAddress,
          body: `${input.message.subject}\n\n${input.message.body}`.slice(0, 4000),
          ...(input.traceId ? { traceId: input.traceId } : {})
        } as unknown as Prisma.ChannelMessageCreateInput
      });
      this.logger.log({
        event: "SCHEDULER_CHANNEL_SENT",
        organizationId: input.organizationId,
        channelConnectionId: channel.id,
        toAddress,
        definitionKey: input.definitionKey
      });
      return true;
    } catch (error) {
      this.logger.warn({
        event: "SCHEDULER_CHANNEL_DELIVERY_FAILED",
        organizationId: input.organizationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  private async deliverViaEmail(input: {
    organizationId: string;
    employeeId: string | null;
    message: ComposedReminder;
    target: DeliveryTarget;
  }): Promise<boolean> {
    const to = input.target.email;
    if (!to) return false;
    if (!this.email.isConfigured()) return false;
    try {
      await this.email.sendMail({
        to,
        subject: input.message.subject,
        text: input.message.body
      });
      return true;
    } catch (error) {
      this.logger.warn({
        event: "SCHEDULER_EMAIL_DELIVERY_FAILED",
        organizationId: input.organizationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  private async findActiveChannelConnection(
    organizationId: string,
    employeeId: string
  ): Promise<string | null> {
    const channel = await this.prisma.channelConnection.findFirst({
      where: {
        organizationId,
        pluginInstallationId: employeeId,
        deletedAt: null,
        status: "ACTIVE",
        channelType: ChannelType.WHATSAPP
      },
      orderBy: { updatedAt: "desc" }
    });
    return channel?.id ?? null;
  }
}
