import { Injectable, Logger } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

export class RazorpayNotConfiguredError extends Error {
  constructor() {
    super("RAZORPAY_NOT_CONFIGURED");
    this.name = "RazorpayNotConfiguredError";
  }
}

export class RazorpayApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`RAZORPAY_API_ERROR_${status}`);
    this.name = "RazorpayApiError";
  }
}

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

/**
 * Thin wrapper over Razorpay's plain REST Orders API (no SDK dependency, matching this codebase's existing
 * fetch-based provider style — see plugin-ai.runtime.ts's OpenAiCompatibleProvider). Stateless and
 * organization-agnostic: every method takes the credentials it needs as a parameter rather than reading
 * process-wide env vars, so each organization's own Razorpay keys (resolved by PaymentSettingsService)
 * are used for its own checkouts — see CreditPurchaseService for how those are looked up per call.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  async createOrder(
    credentials: RazorpayCredentials,
    input: { amountMinor: number; currency: string; receipt: string }
  ): Promise<RazorpayOrder> {
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        payment_capture: 1
      })
    });
    const bodyText = await response.text();
    if (!response.ok) {
      this.logger.warn({ event: "RAZORPAY_CREATE_ORDER_FAILED", status: response.status });
      throw new RazorpayApiError(response.status, bodyText);
    }
    const body = JSON.parse(bodyText) as { id: string; amount: number; currency: string; receipt: string | null; status: string };
    return { id: body.id, amount: body.amount, currency: body.currency, receipt: body.receipt, status: body.status };
  }

  /** Verifies the `razorpay_signature` returned to the checkout success callback — HMAC-SHA256 of
   *  `orderId|paymentId` keyed with the account's key_secret, exactly as Razorpay's own client libraries
   *  compute it. A purchase is only ever marked PAID once this returns true; the client's own claim of
   *  success is never trusted on its own (see CreditPurchaseService.verifyPayment). */
  verifySignature(
    credentials: RazorpayCredentials,
    input: { orderId: string; paymentId: string; signature: string }
  ): boolean {
    const expected = createHmac("sha256", credentials.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(input.signature, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
