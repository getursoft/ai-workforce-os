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

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}

/**
 * Thin wrapper over Razorpay's plain REST Orders API (no SDK dependency, matching this codebase's existing
 * fetch-based provider style — see plugin-ai.runtime.ts's OpenAiCompatibleProvider). Deliberately never
 * fabricates a successful order/payment when credentials are missing — every method throws
 * RazorpayNotConfiguredError instead, so a caller can surface an honest "payments aren't set up yet"
 * message rather than pretending a purchase went through.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  isConfigured(): boolean {
    return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
  }

  /** The publishable key_id the frontend needs to open Razorpay Checkout.js — never the secret. */
  publishableKeyId(): string {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    if (!keyId) throw new RazorpayNotConfiguredError();
    return keyId;
  }

  async createOrder(input: { amountMinor: number; currency: string; receipt: string }): Promise<RazorpayOrder> {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret) throw new RazorpayNotConfiguredError();

    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`
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
  verifySignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keySecret) throw new RazorpayNotConfiguredError();
    const expected = createHmac("sha256", keySecret).update(`${input.orderId}|${input.paymentId}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(input.signature, "hex");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
