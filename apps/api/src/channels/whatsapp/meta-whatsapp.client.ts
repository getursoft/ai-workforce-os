/**
 * Meta Cloud API WhatsApp Business Platform client.
 * Handles sending messages through Meta's Graph API and verifying webhook signatures.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const META_GRAPH_API_VERSION = "v22.0";
const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

export interface MetaSendTextInput {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  text: string;
  replyToMessageId?: string;
}

export interface MetaSendResult {
  providerMessageId: string;
  status: string;
}

export interface MetaMessageStatusUpdate {
  providerMessageId: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Sprint 6.7 — carries a normalized, retry-classifiable code alongside the existing, backward-compatible
 *  `message` string (still prefixed "META_WHATSAPP_SEND_FAILED:"/"META_WHATSAPP_MEDIA_UPLOAD_FAILED:" so
 *  existing `.rejects.toThrow(/META_WHATSAPP_SEND_FAILED/)`-style assertions keep working unchanged). */
export class MetaProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly upstreamStatus?: number
  ) {
    super(message);
  }
}

/** Coarse, status-code-driven classification — mirrors `channel.runtime.ts`'s `statusCode()` for Twilio.
 *  Deliberately status-code-first (not a deep Meta error-subcode table) to match this codebase's existing
 *  level of provider-error sophistication. */
function metaStatusCode(status: number, data: Record<string, unknown>): string {
  const error = data.error as Record<string, unknown> | undefined;
  const type = typeof error?.type === "string" ? error.type : undefined;
  const code = typeof error?.code === "number" ? error.code : undefined;
  if (status === 401 || status === 403 || type === "OAuthException" || code === 190)
    return "META_AUTH_FAILURE";
  if (status === 429 || code === 4 || code === 80007) return "META_RATE_LIMITED";
  if (status >= 500) return "META_PROVIDER_UNAVAILABLE";
  // Meta's "recipient not on WhatsApp"/invalid-number family (131026, 131047, 100 with a "to" param error).
  if (code === 131026 || code === 131047) return "META_INVALID_RECIPIENT";
  // Unsupported/rejected media (document/type errors) — only relevant for document sends.
  if (code === 131052 || code === 131009) return "META_MEDIA_REJECTED";
  return "META_SEND_REJECTED";
}

/**
 * Verifies a Meta webhook payload signature using the App Secret.
 * Meta signs webhook POST bodies with HMAC-SHA256 using the app secret as the key.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const algo = "sha256";
  const expected = createHmac(algo, appSecret).update(rawBody).digest("hex");
  const prefix = `${algo}=`;
  const actual = signatureHeader.startsWith(prefix) ? signatureHeader.slice(prefix.length) : signatureHeader;
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

/**
 * Sends a text message via Meta Cloud API.
 */
export async function sendMetaWhatsAppText(
  input: MetaSendTextInput,
  fetcher: typeof fetch = fetch
): Promise<MetaSendResult> {
  const url = `${META_GRAPH_BASE}/${input.phoneNumberId}/messages`;
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "text",
    text: { body: input.text }
  };
  if (input.replyToMessageId) {
    body.context = { message_id: input.replyToMessageId };
  }
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const errMsg = (data.error as Record<string, unknown>)?.message ?? response.statusText;
    throw new MetaProviderError(
      `META_WHATSAPP_SEND_FAILED: ${errMsg}`,
      metaStatusCode(response.status, data),
      response.status
    );
  }
  const messageId = (data.messages as Array<Record<string, unknown>>)?.[0]?.id as string | undefined;
  return {
    providerMessageId: messageId ?? "unknown",
    status: "sent"
  };
}

export interface MetaUploadMediaInput {
  phoneNumberId: string;
  accessToken: string;
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Uploads binary media (e.g. a generated PDF ticket) to Meta's Media API, returning a media ID that a
 * later `sendMetaWhatsAppDocument` call references. Media must be uploaded before it can be sent — the
 * Cloud API has no "send raw bytes inline" option, only a public `link` (which would require exposing the
 * ticket at an unauthenticated URL) or this upload-then-reference flow, which never does.
 */
export async function uploadMetaWhatsAppMedia(
  input: MetaUploadMediaInput,
  fetcher: typeof fetch = fetch
): Promise<{ mediaId: string }> {
  const url = `${META_GRAPH_BASE}/${input.phoneNumberId}/media`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", input.mimeType);
  form.append("file", new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }), input.filename);
  const response = await fetcher(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.accessToken}` },
    body: form
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof data.id !== "string") {
    const errMsg = (data.error as Record<string, unknown>)?.message ?? response.statusText;
    throw new MetaProviderError(
      `META_WHATSAPP_MEDIA_UPLOAD_FAILED: ${errMsg}`,
      metaStatusCode(response.status, data),
      response.status
    );
  }
  return { mediaId: data.id };
}

export interface MetaSendDocumentInput {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  mediaId: string;
  filename: string;
  caption?: string;
}

/** Sends a previously-uploaded media item (see `uploadMetaWhatsAppMedia`) as a WhatsApp document message. */
export async function sendMetaWhatsAppDocument(
  input: MetaSendDocumentInput,
  fetcher: typeof fetch = fetch
): Promise<MetaSendResult> {
  const url = `${META_GRAPH_BASE}/${input.phoneNumberId}/messages`;
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "document",
    document: {
      id: input.mediaId,
      filename: input.filename,
      ...(input.caption ? { caption: input.caption } : {})
    }
  };
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const errMsg = (data.error as Record<string, unknown>)?.message ?? response.statusText;
    throw new MetaProviderError(
      `META_WHATSAPP_SEND_FAILED: ${errMsg}`,
      metaStatusCode(response.status, data),
      response.status
    );
  }
  const messageId = (data.messages as Array<Record<string, unknown>>)?.[0]?.id as string | undefined;
  return { providerMessageId: messageId ?? "unknown", status: "sent" };
}

/**
 * Marks a message as read via Meta Cloud API.
 */
export async function markMetaMessageRead(
  phoneNumberId: string,
  messageId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const url = `${META_GRAPH_BASE}/${phoneNumberId}/messages`;
  await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId
    })
  });
}

/**
 * Verifies Meta WhatsApp Business Account credentials by calling the phone number API.
 */
export async function verifyMetaCredentials(
  phoneNumberId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch
): Promise<{ status: string; displayPhoneNumber?: string }> {
  const url = `${META_GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`;
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const errMsg = (data.error as Record<string, unknown>)?.message ?? response.statusText;
    throw new Error(`META_CREDENTIAL_VERIFICATION_FAILED: ${errMsg}`);
  }
  return {
    status: "connected",
    ...(data.display_phone_number ? { displayPhoneNumber: String(data.display_phone_number) } : {})
  };
}

/**
 * Exchanges an authorization code for a long-lived access token (for Embedded Signup flow).
 */
export async function exchangeMetaAuthCode(
  appId: string,
  appSecret: string,
  authCode: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch
): Promise<{ accessToken: string; expiresAt: number }> {
  const url = "https://graph.facebook.com/v22.0/oauth/access_token";
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code: authCode,
    redirect_uri: redirectUri
  });
  const response = await fetcher(`${url}?${params}`, { method: "GET" });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`META_TOKEN_EXCHANGE_FAILED: ${(data.error as Record<string, unknown>)?.message ?? "unknown"}`);
  }
  if (!data.access_token) throw new Error("META_TOKEN_EXCHANGE_FAILED: no access_token returned");
  const expiresIn = (data.expires_in as number) ?? 0;
  return {
    accessToken: String(data.access_token),
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0
  };
}

