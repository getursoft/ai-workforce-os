import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  computeTwilioSignature,
  normalizeInboundWhatsAppPayload,
  normalizeWhatsAppAddress,
  TwilioClient,
  TwilioProviderError,
  verifyTwilioSignature,
  WebhookRateLimiter
} from "./channel.runtime";

/** Independent re-implementation of Twilio's documented algorithm, used as an oracle in tests. */
function referenceSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${params[key]}`, url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("computeTwilioSignature / verifyTwilioSignature", () => {
  const authToken = "test-auth-token-with-safe-length";
  const url = "https://api.example.com/api/v1/channels/twilio/whatsapp/webhook/channel-1";
  const params = {
    MessageSid: "SM1234567890",
    From: "whatsapp:+14155238886",
    To: "whatsapp:+14155550100",
    Body: "Hello there"
  };

  it("matches an independent implementation of Twilio's documented HMAC-SHA1 + base64 algorithm", () => {
    expect(computeTwilioSignature(authToken, url, params)).toBe(
      referenceSignature(authToken, url, params)
    );
  });

  it("is sensitive to parameter order changes producing the same sorted result deterministically", () => {
    const reordered = { Body: params.Body, To: params.To, From: params.From, MessageSid: params.MessageSid };
    expect(computeTwilioSignature(authToken, url, params)).toBe(
      computeTwilioSignature(authToken, url, reordered)
    );
  });

  it("accepts a signature computed with the correct auth token and URL", () => {
    const signature = computeTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature(authToken, url, params, signature)).toBe(true);
  });

  it("rejects when the auth token differs", () => {
    const signature = computeTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature("a-different-auth-token-value", url, params, signature)).toBe(
      false
    );
  });

  it("rejects when any parameter is tampered with", () => {
    const signature = computeTwilioSignature(authToken, url, params);
    expect(
      verifyTwilioSignature(authToken, url, { ...params, Body: "tampered" }, signature)
    ).toBe(false);
  });

  it("rejects when the URL differs (e.g. wrong channel id)", () => {
    const signature = computeTwilioSignature(authToken, url, params);
    expect(verifyTwilioSignature(authToken, `${url}-other`, params, signature)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTwilioSignature(authToken, url, params, undefined)).toBe(false);
  });

  it("rejects a malformed/short signature without throwing", () => {
    expect(verifyTwilioSignature(authToken, url, params, "short")).toBe(false);
  });
});

describe("normalizeWhatsAppAddress", () => {
  it("strips the whatsapp: prefix and preserves E.164 formatting", () => {
    expect(normalizeWhatsAppAddress("whatsapp:+14155238886")).toEqual({
      address: "whatsapp:+14155238886",
      externalUserId: "+14155238886"
    });
  });
  it("adds the whatsapp: prefix and a leading + when missing", () => {
    expect(normalizeWhatsAppAddress("14155238886")).toEqual({
      address: "whatsapp:+14155238886",
      externalUserId: "+14155238886"
    });
  });
});

describe("normalizeInboundWhatsAppPayload", () => {
  it("normalizes a plain-text inbound payload", () => {
    const result = normalizeInboundWhatsAppPayload({
      MessageSid: "SM123",
      From: "whatsapp:+14155238886",
      To: "whatsapp:+14155550100",
      Body: "  Hello  ",
      NumMedia: "0"
    });
    expect(result).toEqual({
      providerMessageSid: "SM123",
      fromAddress: "whatsapp:+14155238886",
      toAddress: "whatsapp:+14155550100",
      externalUserId: "+14155238886",
      body: "Hello",
      media: []
    });
  });

  it("captures media metadata without requiring body text", () => {
    const result = normalizeInboundWhatsAppPayload({
      MessageSid: "SM124",
      From: "whatsapp:+14155238886",
      To: "whatsapp:+14155550100",
      NumMedia: "2",
      MediaUrl0: "https://api.twilio.com/media/0",
      MediaContentType0: "image/jpeg",
      MediaUrl1: "https://api.twilio.com/media/1",
      MediaContentType1: "image/png"
    });
    expect(result.body).toBe("");
    expect(result.media).toEqual([
      { url: "https://api.twilio.com/media/0", contentType: "image/jpeg" },
      { url: "https://api.twilio.com/media/1", contentType: "image/png" }
    ]);
  });

  it("throws when required fields are missing", () => {
    expect(() => normalizeInboundWhatsAppPayload({ Body: "hi" })).toThrow(
      "CHANNEL_WEBHOOK_PAYLOAD_INVALID"
    );
  });
});

describe("TwilioClient", () => {
  it("sends a WhatsApp message using Basic auth and form encoding", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ sid: "SM999", status: "queued" }));
    const client = new TwilioClient(fetcher);
    const result = await client.sendWhatsAppMessage({
      accountSid: "AC123",
      authToken: "secret-token",
      from: "whatsapp:+14155238886",
      to: "whatsapp:+14155550100",
      body: "Hi there"
    });
    expect(result).toEqual({ providerMessageSid: "SM999", status: "queued" });
    const [calledUrl, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Basic /);
    expect(String(init.body)).toContain("Body=Hi+there");
  });

  it("maps authentication failures to a typed provider error without leaking upstream details", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ code: 20003, message: "Authenticate" }, 401));
    const client = new TwilioClient(fetcher);
    await expect(
      client.sendWhatsAppMessage({
        accountSid: "AC123",
        authToken: "bad-token",
        from: "whatsapp:+14155238886",
        to: "whatsapp:+14155550100",
        body: "Hi"
      })
    ).rejects.toMatchObject({ code: "CHANNEL_PROVIDER_AUTHENTICATION_FAILED" });
  });

  it("verifies credentials via a harmless GET without sending a message", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ status: "active" }));
    const client = new TwilioClient(fetcher);
    const result = await client.verifyCredentials({ accountSid: "AC123", authToken: "token" });
    expect(result).toEqual({ status: "active" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("wraps network failures as CHANNEL_PROVIDER_UNAVAILABLE", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network down"));
    const client = new TwilioClient(fetcher);
    await expect(
      client.verifyCredentials({ accountSid: "AC123", authToken: "token" })
    ).rejects.toBeInstanceOf(TwilioProviderError);
  });
});

describe("WebhookRateLimiter", () => {
  it("allows requests under the limit and blocks once the window is exceeded", () => {
    const limiter = new WebhookRateLimiter(3, 10_000);
    const now = 1_000_000;
    expect(limiter.allow("channel-1", now)).toBe(true);
    expect(limiter.allow("channel-1", now)).toBe(true);
    expect(limiter.allow("channel-1", now)).toBe(true);
    expect(limiter.allow("channel-1", now)).toBe(false);
  });
  it("resets once the window has elapsed", () => {
    const limiter = new WebhookRateLimiter(1, 10_000);
    expect(limiter.allow("channel-1", 0)).toBe(true);
    expect(limiter.allow("channel-1", 5_000)).toBe(false);
    expect(limiter.allow("channel-1", 10_001)).toBe(true);
  });
  it("tracks separate keys independently", () => {
    const limiter = new WebhookRateLimiter(1, 10_000);
    expect(limiter.allow("channel-1", 0)).toBe(true);
    expect(limiter.allow("channel-2", 0)).toBe(true);
  });
});
