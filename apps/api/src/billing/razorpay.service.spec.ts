import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RazorpayNotConfiguredError, RazorpayService } from "./razorpay.service";

describe("RazorpayService", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports not configured and throws rather than fabricating a key/order when no credentials are set", () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    const service = new RazorpayService();
    expect(service.isConfigured()).toBe(false);
    expect(() => service.publishableKeyId()).toThrow(RazorpayNotConfiguredError);
    expect(() => service.verifySignature({ orderId: "o1", paymentId: "p1", signature: "x" })).toThrow(
      RazorpayNotConfiguredError
    );
  });

  describe("verifySignature", () => {
    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
      process.env.RAZORPAY_KEY_SECRET = "test_secret";
    });

    it("accepts a correctly computed HMAC-SHA256 signature", () => {
      const service = new RazorpayService();
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ789";
      const signature = createHmac("sha256", "test_secret").update(`${orderId}|${paymentId}`).digest("hex");
      expect(service.verifySignature({ orderId, paymentId, signature })).toBe(true);
    });

    it("rejects a tampered or forged signature", () => {
      const service = new RazorpayService();
      expect(
        service.verifySignature({ orderId: "order_ABC123", paymentId: "pay_XYZ789", signature: "0".repeat(64) })
      ).toBe(false);
    });

    it("rejects a signature computed with the wrong secret (never trusts the client's own claim)", () => {
      const service = new RazorpayService();
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ789";
      const wrongSignature = createHmac("sha256", "attacker-guessed-secret")
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
      expect(service.verifySignature({ orderId, paymentId, signature: wrongSignature })).toBe(false);
    });
  });
});
