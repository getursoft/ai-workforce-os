import { Injectable, Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Per-call SMTP override (see EmailConfigurationService) — when provided, `sendMail` uses this
 *  configuration instead of the process-wide `SMTP_*` env vars, so each AI employee installation can
 *  send from its own mailbox. */
export interface SmtpTransportConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  fromEmail: string;
  fromName: string | null;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. When present, the message is sent as multipart (HTML + the `text` fallback);
   *  when absent, behavior is unchanged from before HTML support existed (plain text only). */
  html?: string;
  attachments?: EmailAttachment[];
  /** Per-installation SMTP settings (see EmailConfigurationService.resolve) — falls back to the
   *  process-wide SMTP_* env vars when omitted. */
  smtp?: SmtpTransportConfig;
}

export interface SendMailResult {
  messageId: string;
}

/** Thrown when SMTP isn't configured — sending is never silently skipped or faked as successful; the
 *  caller must decide how to record/report the failure (see DeliveryRecorderService). */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("EMAIL_NOT_CONFIGURED");
  }
}

/**
 * Thin SMTP wrapper (nodemailer). Reads its default configuration lazily, straight from `process.env`
 * (SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASSWORD/SMTP_FROM_EMAIL/SMTP_FROM_NAME) rather than
 * through the boot-time-required `SecurityConfig`: unlike core auth/session secrets, an unconfigured mail
 * server must never crash the whole API on startup, only fail the specific send that needed it. Callers
 * that have their own per-installation SMTP settings (see EmailConfigurationService) pass them as
 * `SendMailInput.smtp` to override the env defaults entirely.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private envTransporter: Transporter | null = null;
  private envTransporterHost: string | null = null;

  /** True when either an explicit per-call config or the env defaults have a usable SMTP host. */
  isConfigured(smtp?: SmtpTransportConfig): boolean {
    if (smtp) return Boolean(smtp.host?.trim());
    return Boolean(process.env.SMTP_HOST?.trim());
  }

  /** Sprint 4.7A Phase 7: a real connectivity check (nodemailer's SMTP handshake/verify — no email sent)
   *  for the live health dashboard. Returns false for both "not configured" and "configured but
   *  unreachable" — callers that need to distinguish those call `isConfigured()` first. */
  async verifyConnection(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.getEnvTransporter().verify();
      return true;
    } catch {
      return false;
    }
  }

  private buildTransporter(config: SmtpTransportConfig): Transporter {
    return nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password ?? "" } : undefined
    });
  }

  private getEnvTransporter(): Transporter {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) throw new EmailNotConfiguredError();
    // Rebuild only if the host changed (covers tests that flip env vars between cases) — the common
    // case (one process, one SMTP config for its lifetime) reuses a single pooled transporter.
    if (this.envTransporter && this.envTransporterHost === host) return this.envTransporter;
    const port = Number(process.env.SMTP_PORT ?? "587");
    this.envTransporter = this.buildTransporter({
      host,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      user: process.env.SMTP_USER ?? null,
      password: process.env.SMTP_PASSWORD ?? null,
      fromEmail: "",
      fromName: null
    });
    this.envTransporterHost = host;
    return this.envTransporter;
  }

  async sendMail(input: SendMailInput): Promise<SendMailResult> {
    if (input.smtp && !input.smtp.host.trim()) throw new EmailNotConfiguredError();
    const transporter = input.smtp ? this.buildTransporter(input.smtp) : this.getEnvTransporter();
    const fromEmail =
      input.smtp?.fromEmail?.trim() || process.env.SMTP_FROM_EMAIL?.trim() || process.env.SMTP_USER?.trim();
    if (!fromEmail) throw new EmailNotConfiguredError();
    const fromName = input.smtp?.fromName?.trim() || process.env.SMTP_FROM_NAME?.trim();
    const info = await transporter.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType
      }))
    });
    this.logger.log({ event: "EMAIL_SENT", to: input.to, messageId: info.messageId });
    return { messageId: info.messageId };
  }
}
