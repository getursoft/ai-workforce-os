import { describe, expect, it } from "vitest";
import { MockSmsProvider } from "./mock-sms.provider";

describe("MockSmsProvider (Sprint 7.12 STEP 14/35)", () => {
  it("is always configured — zero credentials required", () => {
    expect(new MockSmsProvider().isConfigured()).toBe(true);
  });

  it("succeeds deterministically by default", async () => {
    const provider = new MockSmsProvider();
    const result = await provider.send({ to: "+14155551234", message: "Your reference is KRV-842731" });
    expect(result).toMatchObject({ provider: "mock", status: "SENT", error: null, retryable: false });
    expect(result.messageId).toBeTruthy();
  });

  it("simulates a one-shot transient failure then reverts to success", async () => {
    const provider = new MockSmsProvider();
    provider.simulateNextFailure("transient");
    const first = await provider.send({ to: "+14155551234", message: "x" });
    expect(first).toMatchObject({ status: "FAILED", error: "MOCK_SMS_TRANSIENT_ERROR", retryable: true });
    const second = await provider.send({ to: "+14155551234", message: "x" });
    expect(second.status).toBe("SENT");
  });

  it("simulates a permanent failure as non-retryable", async () => {
    const provider = new MockSmsProvider();
    provider.simulateNextFailure("permanent");
    const result = await provider.send({ to: "+14155551234", message: "x" });
    expect(result).toMatchObject({ status: "FAILED", error: "MOCK_SMS_PERMANENT_ERROR", retryable: false });
  });
});
