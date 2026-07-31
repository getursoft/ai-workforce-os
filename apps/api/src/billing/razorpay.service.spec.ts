import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RazorpayService } from "./razorpay.service";

describe("RazorpayService", () => {
  const credentials = { keyId: "rzp_test_key", keySecret: "test_secret" };

  describe("verifySignature", () => {
    it("accepts a correctly computed HMAC-SHA256 signature", () => {
      const service = new RazorpayService();
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ789";
      const signature = createHmac("sha256", "test_secret").update(`${orderId}|${paymentId}`).digest("hex");
      expect(service.verifySignature(credentials, { orderId, paymentId, signature })).toBe(true);
    });

    it("rejects a tampered or forged signature", () => {
      const service = new RazorpayService();
      expect(
        service.verifySignature(credentials, {
          orderId: "order_ABC123",
          paymentId: "pay_XYZ789",
          signature: "0".repeat(64)
        })
      ).toBe(false);
    });

    it("rejects a signature computed with the wrong secret (never trusts the client's own claim)", () => {
      const service = new RazorpayService();
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ789";
      const wrongSignature = createHmac("sha256", "attacker-guessed-secret")
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
      expect(service.verifySignature(credentials, { orderId, paymentId, signature: wrongSignature })).toBe(false);
    });

    it("rejects a signature verified against a different organization's credentials", () => {
      const service = new RazorpayService();
      const orderId = "order_ABC123";
      const paymentId = "pay_XYZ789";
      const signature = createHmac("sha256", "test_secret").update(`${orderId}|${paymentId}`).digest("hex");
      expect(
        service.verifySignature({ keyId: "rzp_other", keySecret: "other_secret" }, { orderId, paymentId, signature })
      ).toBe(false);
    });
  });
});
