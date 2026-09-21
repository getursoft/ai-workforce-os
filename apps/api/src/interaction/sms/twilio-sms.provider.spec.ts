import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioSmsProvider } from "./twilio-sms.provider";

const ORIGINAL_ENV = { ...process.env };

describe("TwilioSmsProvider (Sprint 7.12 STEP 14) — no live credentials required for these tests", () => {
  beforeEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM_NUMBER;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not configured when credentials are unset", () => {
    expect(new TwilioSmsProvider().isConfigured()).toBe(false);
  });

  it("fails cleanly (never fabricates success) when send() is called unconfigured", async () => {
    const provider = new TwilioSmsProvider();
    const result = await provider.send({ to: "+14155551234", message: "x" });
    expect(result).toMatchObject({ status: "FAILED", error: "TWILIO_SMS_NOT_CONFIGURED" });
  });

  it("reports configured and sends once credentials are present", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
    process.env.TWILIO_AUTH_TOKEN = "secret-token";
    process.env.TWILIO_SMS_FROM_NUMBER = "+15550001111";
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ sid: "SM123", status: "queued" })
    });
    const provider = new TwilioSmsProvider(fetcher as never);
    expect(provider.isConfigured()).toBe(true);
    const result = await provider.send({ to: "+14155551234", message: "Your reference is KRV-842731" });
    expect(result).toMatchObject({ status: "SENT", messageId: "SM123", provider: "twilio" });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/Accounts/AC" + "a".repeat(32) + "/Messages.json"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("classifies a provider rejection as a normalized, non-retryable error", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
    process.env.TWILIO_AUTH_TOKEN = "secret-token";
    process.env.TWILIO_SMS_FROM_NUMBER = "+15550001111";
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: 21211, message: "Invalid To number" })
    });
    const provider = new TwilioSmsProvider(fetcher as never);
    const result = await provider.send({ to: "not-a-number", message: "x" });
    expect(result).toMatchObject({ status: "FAILED", error: "TWILIO_SMS_REJECTED", retryable: false });
  });
});
