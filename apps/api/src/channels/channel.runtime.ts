import { createHmac, timingSafeEqual } from "node:crypto";

export interface NormalizedInboundWhatsAppMessage {
  providerMessageSid: string;
  fromAddress: string;
  toAddress: string;
  externalUserId: string;
  body: string;
  media: Array<{ url: string; contentType: string }>;
}

export interface TwilioSendResult {
  providerMessageSid: string;
  status: string;
}

export class TwilioSignatureError extends Error {
  constructor() {
    super("CHANNEL_WEBHOOK_SIGNATURE_INVALID");
  }
}

export class TwilioProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly upstreamStatus?: number
  ) {
    super(code);
  }
}

/** Computes the Twilio request signature: HMAC-SHA1(url + sorted key+value pairs), base64 encoded. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${params[key]}`, url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Normalizes a raw "whatsapp:+14155238886" style address into a stable external user id (E.164, no prefix). */
export function normalizeWhatsAppAddress(raw: string): { address: string; externalUserId: string } {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, "").trim();
  const digits = withoutPrefix.replace(/[^\d+]/g, "");
  const externalUserId = digits.startsWith("+") ? digits : `+${digits}`;
  return { address: `whatsapp:${externalUserId}`, externalUserId };
}

export function normalizeInboundWhatsAppPayload(
  raw: Readonly<Record<string, unknown>>
): NormalizedInboundWhatsAppMessage {
  const messageSid = stringField(raw, "MessageSid");
  const from = stringField(raw, "From");
  const to = stringField(raw, "To");
  if (!messageSid || !from || !to) throw new Error("CHANNEL_WEBHOOK_PAYLOAD_INVALID");
  const body = stringField(raw, "Body") ?? "";
  const numMedia = Math.min(Math.max(Number(stringField(raw, "NumMedia") ?? "0") || 0, 0), 10);
  const media: Array<{ url: string; contentType: string }> = [];
  for (let index = 0; index < numMedia; index++) {
    const url = stringField(raw, `MediaUrl${index}`);
    if (!url) continue;
    media.push({ url, contentType: stringField(raw, `MediaContentType${index}`) ?? "" });
  }
  return {
    providerMessageSid: messageSid,
    fromAddress: normalizeWhatsAppAddress(from).address,
    toAddress: normalizeWhatsAppAddress(to).address,
    externalUserId: normalizeWhatsAppAddress(from).externalUserId,
    body: body.trim().slice(0, 4000),
    media
  };
}

function stringField(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type Fetcher = typeof fetch;

/** Twilio-specific outbound REST client. Kept isolated so no other module depends on Twilio's wire format. */
export class TwilioClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  /** Harmless GET used to validate credentials without sending a message or incurring cost. */
  async verifyCredentials(input: {
    accountSid: string;
    authToken: string;
    timeoutMs?: number;
  }): Promise<{ status: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(input.timeoutMs ?? 10_000, 20_000));
    try {
      const response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}.json`,
        {
          method: "GET",
          headers: {
            authorization: `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString("base64")}`,
            "user-agent": "AI-Workforce-OS/1.0"
          },
          signal: controller.signal
        }
      );
      const payload = await safeJson(response);
      if (!response.ok)
        throw new TwilioProviderError(statusCode(response.status, payload), response.status);
      return { status: String(payload.status ?? "active") };
    } catch (error) {
      if (error instanceof TwilioProviderError) throw error;
      throw new TwilioProviderError(
        error instanceof Error && error.name === "AbortError"
          ? "CHANNEL_PROVIDER_TIMEOUT"
          : "CHANNEL_PROVIDER_UNAVAILABLE"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async sendWhatsAppMessage(input: {
    accountSid: string;
    authToken: string;
    from: string;
    to: string;
    body: string;
    timeoutMs?: number;
  }): Promise<TwilioSendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(input.timeoutMs ?? 10_000, 20_000));
    try {
      const form = new URLSearchParams({
        From: normalizeWhatsAppAddress(input.from).address,
        To: normalizeWhatsAppAddress(input.to).address,
        Body: input.body
      });
      const response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "AI-Workforce-OS/1.0"
          },
          body: form.toString(),
          signal: controller.signal
        }
      );
      const payload = await safeJson(response);
      if (!response.ok)
        throw new TwilioProviderError(statusCode(response.status, payload), response.status);
      const sid = typeof payload.sid === "string" ? payload.sid : undefined;
      if (!sid) throw new TwilioProviderError("CHANNEL_PROVIDER_RESPONSE_INVALID");
      return { providerMessageSid: sid, status: String(payload.status ?? "queued") };
    } catch (error) {
      if (error instanceof TwilioProviderError) throw error;
      throw new TwilioProviderError(
        error instanceof Error && error.name === "AbortError"
          ? "CHANNEL_PROVIDER_TIMEOUT"
          : "CHANNEL_PROVIDER_UNAVAILABLE"
      );
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

function statusCode(status: number, payload: Record<string, unknown>): string {
  const code = typeof payload.code === "number" ? payload.code : undefined;
  if (status === 401 || status === 403 || code === 20003) return "CHANNEL_PROVIDER_AUTHENTICATION_FAILED";
  if (status === 429) return "CHANNEL_PROVIDER_RATE_LIMITED";
  if (status >= 500) return "CHANNEL_PROVIDER_UNAVAILABLE";
  return "CHANNEL_PROVIDER_REJECTED";
}

/** Small in-memory sliding-window limiter for the webhook endpoint (no dedicated rate-limiting infra exists yet). */
export class WebhookRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit = 30,
    private readonly windowMs = 10_000
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
