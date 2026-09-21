/** Sprint 7.12 STEP 14 — real Twilio SMS sending, structurally parallel to
 * TwilioClient.sendWhatsAppMessage (channels/channel.runtime.ts) but a distinct method/endpoint call
 * (plain SMS never carries the "whatsapp:" address prefix). Never used unless
 * TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_SMS_FROM_NUMBER are configured — `isConfigured()` returning
 * false is the caller's signal to skip this provider entirely, never a fabricated credential.
 */
import { Injectable, Optional } from "@nestjs/common";
import type { SmsProvider, SmsSendInput, SmsSendResult } from "./sms-provider.types";

type Fetcher = typeof fetch;

function classify(status: number, code: number | undefined): { errorCode: string; retryable: boolean } {
  if (status === 401 || status === 403 || code === 20003)
    return { errorCode: "TWILIO_SMS_AUTHENTICATION_FAILED", retryable: false };
  if (status === 429) return { errorCode: "TWILIO_SMS_RATE_LIMITED", retryable: true };
  if (status >= 500) return { errorCode: "TWILIO_SMS_PROVIDER_UNAVAILABLE", retryable: true };
  return { errorCode: "TWILIO_SMS_REJECTED", retryable: false };
}

@Injectable()
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";

  // Sprint 7.12: @Optional() so Nest's DI never tries to resolve a provider for the `Fetcher` type
  // (reflect-metadata sees a plain `Object` for a function-typed param) — this parameter exists purely as
  // a test-injection seam (see twilio-sms.provider.spec.ts), matching TwilioClient's own
  // constructor(private readonly fetcher: Fetcher = fetch) pattern, which never hits this because
  // TwilioClient is constructed manually with `new`, not through Nest's DI container.
  constructor(@Optional() private readonly fetcher: Fetcher = fetch) {}

  isConfigured(): boolean {
    return Boolean(
      process.env.TWILIO_ACCOUNT_SID?.trim() &&
        process.env.TWILIO_AUTH_TOKEN?.trim() &&
        process.env.TWILIO_SMS_FROM_NUMBER?.trim()
    );
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const from = process.env.TWILIO_SMS_FROM_NUMBER?.trim();
    if (!accountSid || !authToken || !from)
      return { provider: this.name, status: "FAILED", messageId: null, error: "TWILIO_SMS_NOT_CONFIGURED", retryable: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const form = new URLSearchParams({ From: from, To: input.to, Body: input.message });
      const response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "AI-Workforce-OS/1.0"
          },
          body: form.toString(),
          signal: controller.signal
        }
      );
      const payload = await safeJson(response);
      if (!response.ok) {
        const code = typeof payload.code === "number" ? payload.code : undefined;
        const { errorCode, retryable } = classify(response.status, code);
        return { provider: this.name, status: "FAILED", messageId: null, error: errorCode, retryable };
      }
      const sid = typeof payload.sid === "string" ? payload.sid : null;
      if (!sid)
        return { provider: this.name, status: "FAILED", messageId: null, error: "TWILIO_SMS_RESPONSE_INVALID", retryable: true };
      return { provider: this.name, status: "SENT", messageId: sid, error: null, retryable: false };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        provider: this.name,
        status: "FAILED",
        messageId: null,
        error: timedOut ? "TWILIO_SMS_TIMEOUT" : "TWILIO_SMS_UNAVAILABLE",
        retryable: true
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
