import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { CreditPurchaseService } from "./credit-purchase.service";
import type { RazorpayService } from "./razorpay.service";
import type { PaymentSettingsService } from "./payment-settings.service";

function harness(overrides: { isConfigured?: boolean; verifySignature?: boolean } = {}) {
  const orders = new Map<string, Record<string, unknown>>();
  let seq = 0;
  const subscription = {
    organizationId: "org-1",
    monthlyCreditAllowanceOverride: null as number | null,
    plan: { monthlyCreditAllowance: 500_000, overageRateMicrosPerCredit: 1000 }
  };

  const prisma = {
    organisationSubscription: {
      findUnique: vi.fn().mockImplementation(() => Promise.resolve(subscription)),
      update: vi.fn().mockImplementation(({ data }: { data: { monthlyCreditAllowanceOverride: number } }) => {
        subscription.monthlyCreditAllowanceOverride = data.monthlyCreditAllowanceOverride;
        return Promise.resolve(subscription);
      })
    },
    creditPurchaseOrder: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const id = `order-${++seq}`;
        const row = { id, gatewayOrderId: null, gatewayPaymentId: null, paidAt: null, ...data };
        orders.set(id, row);
        return Promise.resolve(row);
      }),
      update: vi.fn().mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = orders.get(where.id);
        if (!existing) throw new Error("not found");
        const updated = { ...existing, ...data };
        orders.set(where.id, updated);
        return Promise.resolve(updated);
      }),
      findFirst: vi.fn().mockImplementation(({ where }: { where: { id: string; organizationId: string } }) => {
        const row = orders.get(where.id);
        return Promise.resolve(row && row.organizationId === where.organizationId ? row : null);
      })
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(prisma);
    })
  } as unknown as PrismaService;

  const razorpay = {
    createOrder: vi.fn().mockResolvedValue({ id: "order_gw_1", amount: 10_000, currency: "INR", receipt: "r1", status: "created" }),
    verifySignature: vi.fn().mockImplementation(() => {
      if (overrides.verifySignature === undefined) return true;
      return overrides.verifySignature;
    })
  } as unknown as RazorpayService;

  const paymentSettings = {
    resolve: vi
      .fn()
      .mockResolvedValue(
        (overrides.isConfigured ?? true) ? { keyId: "rzp_test_key", keySecret: "test_secret" } : null
      )
  } as unknown as PaymentSettingsService;

  return {
    service: new CreditPurchaseService(prisma, razorpay, paymentSettings),
    prisma,
    razorpay,
    paymentSettings,
    subscription,
    orders
  };
}

describe("CreditPurchaseService.createOrder", () => {
  it("rejects a credits amount that doesn't match a published package tier", async () => {
    const { service } = harness();
    await expect(service.createOrder("org-1", "user-1", 12_345)).rejects.toMatchObject({
      code: "INVALID_CREDIT_PACKAGE"
    });
  });

  it("throws an honest PAYMENT_GATEWAY_NOT_CONFIGURED error rather than fabricating an order when Razorpay isn't configured", async () => {
    const { service } = harness({ isConfigured: false });
    await expect(service.createOrder("org-1", "user-1", 10_000)).rejects.toMatchObject({
      code: "PAYMENT_GATEWAY_NOT_CONFIGURED"
    });
  });

  it("creates a local PENDING order and attaches the real gateway order id for a valid tier", async () => {
    const { service, razorpay } = harness();
    const result = await service.createOrder("org-1", "user-1", 10_000);
    expect(result.credits).toBe(10_000);
    expect(result.status).toBe("PENDING");
    expect(result.gatewayOrderId).toBe("order_gw_1");
    expect(razorpay.createOrder).toHaveBeenCalledWith(
      { keyId: "rzp_test_key", keySecret: "test_secret" },
      expect.objectContaining({ amountMinor: 10_000, currency: "INR" })
    );
  });
});

describe("CreditPurchaseService.verifyPayment", () => {
  it("never marks an order PAID or grants credits when the signature doesn't verify", async () => {
    const { service } = harness({ verifySignature: false });
    const order = await service.createOrder("org-1", "user-1", 10_000);
    await expect(
      service.verifyPayment("org-1", order.id, {
        razorpayOrderId: order.gatewayOrderId as string,
        razorpayPaymentId: "pay_1",
        razorpaySignature: "forged"
      })
    ).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
  });

  it("rejects when the client-supplied gateway order id doesn't match the order actually created", async () => {
    const { service } = harness();
    const order = await service.createOrder("org-1", "user-1", 10_000);
    await expect(
      service.verifyPayment("org-1", order.id, {
        razorpayOrderId: "order_someone_elses",
        razorpayPaymentId: "pay_1",
        razorpaySignature: "sig"
      })
    ).rejects.toMatchObject({ code: "CREDIT_PURCHASE_ORDER_MISMATCH" });
  });

  it("marks the order PAID and increases the org's credit allowance for the current cycle on a verified signature", async () => {
    const { service, subscription } = harness({ verifySignature: true });
    const order = await service.createOrder("org-1", "user-1", 50_000);

    const result = await service.verifyPayment("org-1", order.id, {
      razorpayOrderId: order.gatewayOrderId as string,
      razorpayPaymentId: "pay_1",
      razorpaySignature: "valid"
    });

    expect(result).toEqual({ status: "PAID", credits: 50_000 });
    expect(subscription.monthlyCreditAllowanceOverride).toBe(500_000 + 50_000);
  });

  it("is idempotent — verifying an already-PAID order again returns the same result without re-granting credits", async () => {
    const { service, subscription } = harness({ verifySignature: true });
    const order = await service.createOrder("org-1", "user-1", 50_000);
    const verify = () =>
      service.verifyPayment("org-1", order.id, {
        razorpayOrderId: order.gatewayOrderId as string,
        razorpayPaymentId: "pay_1",
        razorpaySignature: "valid"
      });

    await verify();
    await verify();

    expect(subscription.monthlyCreditAllowanceOverride).toBe(500_000 + 50_000);
  });

  it("rejects re-verifying a FAILED order", async () => {
    const { service } = harness({ verifySignature: false });
    const order = await service.createOrder("org-1", "user-1", 10_000);
    await expect(
      service.verifyPayment("org-1", order.id, {
        razorpayOrderId: order.gatewayOrderId as string,
        razorpayPaymentId: "pay_1",
        razorpaySignature: "forged"
      })
    ).rejects.toMatchObject({ code: "PAYMENT_SIGNATURE_INVALID" });
    await expect(
      service.verifyPayment("org-1", order.id, {
        razorpayOrderId: order.gatewayOrderId as string,
        razorpayPaymentId: "pay_2",
        razorpaySignature: "still-forged"
      })
    ).rejects.toMatchObject({ code: "CREDIT_PURCHASE_ORDER_NOT_PENDING" });
  });
});
