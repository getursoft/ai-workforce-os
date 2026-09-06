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

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/** Resolves the Twilio credentials actually used for a given channel. `TWILIO_ACCOUNT_SID` /
 *  `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` env vars — when ALL THREE are set — take priority over
 *  the channel's own encrypted-in-database configuration, applied consistently everywhere Twilio
 *  credentials are used (inbound signature verification, outbound send, the `/test` endpoint) so the
 *  three never disagree about which credential set is authoritative. Falls back to the per-channel
 *  database values (accountSid/fromNumber from `configuration`, authToken decrypted from
 *  `encryptedSecrets`) when the env vars aren't fully set — e.g. for other organizations' channels. */
export function resolveTwilioCredentials(
  channelDb: {
    accountSid?: string | undefined;
    authToken?: string | undefined;
    fromNumber?: string | undefined;
  }
): TwilioCredentials | null {
  const envAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const envAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const envFromNumber = process.env.TWILIO_WHATSAPP_FROM?.trim();
  if (envAccountSid && envAuthToken && envFromNumber) {
    return { accountSid: envAccountSid, authToken: envAuthToken, fromNumber: envFromNumber };
  }
  if (!channelDb.accountSid || !channelDb.authToken || !channelDb.fromNumber) return null;
  return {
    accountSid: channelDb.accountSid,
    authToken: channelDb.authToken,
    fromNumber: channelDb.fromNumber
  };
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

export type NormalizedDeliveryErrorCode =
  | "RATE_LIMITED"
  | "INVALID_RECIPIENT"
  | "AUTH_FAILURE"
  | "MEDIA_REJECTED"
  | "NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

/** Sprint 6.7 — maps a provider-specific error code (Twilio's `statusCode()` output, Meta's
 *  `metaStatusCode()` output, or one of this processor's own credential/timeout codes) into the brief's
 *  normalized outcome set, plus whether it's worth retrying. Provider-specific codes never leak past this
 *  boundary into the core delivery/workflow logic — only the normalized code and the boolean do. */
export function classifyProviderError(code: string): {
  normalized: NormalizedDeliveryErrorCode;
  retryable: boolean;
} {
  switch (code) {
    case "CHANNEL_PROVIDER_RATE_LIMITED":
    case "META_RATE_LIMITED":
      return { normalized: "RATE_LIMITED", retryable: true };
    case "CHANNEL_PROVIDER_AUTHENTICATION_FAILED":
    case "META_AUTH_FAILURE":
    case "CHANNEL_CREDENTIALS_REQUIRED":
    case "META_CREDENTIALS_REQUIRED":
      return { normalized: "AUTH_FAILURE", retryable: false };
    case "CHANNEL_PROVIDER_REJECTED":
    case "META_INVALID_RECIPIENT":
    case "META_SEND_REJECTED":
      return { normalized: "INVALID_RECIPIENT", retryable: false };
    case "META_MEDIA_REJECTED":
      return { normalized: "MEDIA_REJECTED", retryable: false };
    case "CHANNEL_PROVIDER_TIMEOUT":
      return { normalized: "NETWORK_ERROR", retryable: true };
    case "CHANNEL_PROVIDER_UNAVAILABLE":
    case "META_PROVIDER_UNAVAILABLE":
    case "CHANNEL_PROVIDER_RESPONSE_INVALID":
      return { normalized: "PROVIDER_UNAVAILABLE", retryable: true };
    default:
      // Unrecognized codes (a new provider error class, a raw network exception message) fail open on the
      // retryable side — bounded by MAX_ATTEMPTS, so an unknown-but-permanent error still terminates
      // eventually rather than being silently swallowed as un-retryable on day one.
      return { normalized: "UNKNOWN", retryable: true };
  }
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
