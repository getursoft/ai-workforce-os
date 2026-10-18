import { Injectable, Logger } from "@nestjs/common";
import { TwilioClient, resolveTwilioCredentials, type TwilioCredentials } from "../../channels/channel.runtime";

/**
 * Sprint 7.16 — Recruitment's own outbound WhatsApp sender. Deliberately a thin, separate wrapper around
 * the existing, already-tested `TwilioClient` (apps/api/src/channels/channel.runtime.ts) rather than
 * reusing `ChannelMessageProcessor`'s send path, which is wired to the Receptionist/EmployeeRouter
 * conversation flow this feature must stay independent of. `resolveTwilioCredentials({})` resolves purely
 * from the `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` env vars when all three are
 * set (true in this environment's .env) — Recruitment's WhatsApp line needs no per-organization
 * ChannelConnection row to send from the same configured Twilio Sandbox number.
 */
@Injectable()
export class RecruitmentWhatsAppSenderService {
  private readonly logger = new Logger(RecruitmentWhatsAppSenderService.name);
  private readonly client = new TwilioClient();

  isConfigured(): boolean {
    return this.credentials() !== null;
  }

  credentials(): TwilioCredentials | null {
    return resolveTwilioCredentials({});
  }

  /** Never throws — a send failure (e.g. the recipient hasn't joined the Twilio Sandbox) is logged and
   * swallowed, since the webhook handler that calls this must still return 200 to Twilio either way. */
  async sendText(toE164: string, body: string): Promise<boolean> {
    const credentials = this.credentials();
    if (!credentials) {
      this.logger.warn({ event: "RecruitmentWhatsAppSendSkipped", reason: "NOT_CONFIGURED" });
      return false;
    }
    try {
      await this.client.sendWhatsAppMessage({
        accountSid: credentials.accountSid,
        authToken: credentials.authToken,
        from: credentials.fromNumber,
        to: toE164,
        body: body.slice(0, 1600)
      });
      return true;
    } catch (error) {
      this.logger.warn({ event: "RecruitmentWhatsAppSendFailed", error: String(error) });
      return false;
    }
  }
}
