import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { buildCreditPackages, findPackageByCredits, type CreditPackage } from "./credit-package";
import { RazorpayService } from "./razorpay.service";
import { PaymentSettingsService } from "./payment-settings.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";

function notConfigured(): IdentityApplicationError {
  return new IdentityApplicationError(
    "PAYMENT_GATEWAY_NOT_CONFIGURED",
    "Payments aren't set up for this workspace yet. Please contact support to enable credit top-ups."
  );
}

export interface CreditPurchaseOrderView {
  id: string;
  credits: number;
  amountMinor: number;
  currency: string;
  status: string;
  gatewayOrderId: string | null;
  razorpayKeyId: string;
}

export interface CreditPurchaseOrderSummary {
  id: string;
  credits: number;
  amountMinor: number;
  currency: string;
  status: string;
  gateway: string;
  createdAt: string;
  paidAt: string | null;
}

@Injectable()
export class CreditPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly paymentSettings: PaymentSettingsService
  ) {}

  /** Recharge transaction history — the credit purchase orders themselves ARE the ledger for top-ups;
   *  no separate wallet/transaction table. Usage-side debits are covered by `GET /billing/usage/trend`. */
  async listOrders(organizationId: string, take = 50): Promise<CreditPurchaseOrderSummary[]> {
    const orders = await this.prisma.creditPurchaseOrder.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take
    });
    return orders.map((o) => ({
      id: o.id, credits: o.credits, amountMinor: o.amountMinor, currency: o.currency,
      status: o.status, gateway: o.gateway,
      createdAt: o.createdAt.toISOString(), paidAt: o.paidAt?.toISOString() ?? null
    }));
  }

  async listPackages(organizationId: string): Promise<{ currency: string; packages: CreditPackage[] }> {
    const sub = await this.prisma.organisationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true }
    });
    const rate = sub?.plan?.overageRateMicrosPerCredit ?? 1000;
    const currency = "INR";
    return { currency, packages: buildCreditPackages(rate, currency) };
  }

  async createOrder(organizationId: string, userId: string, credits: number): Promise<CreditPurchaseOrderView> {
    const credentials = await this.paymentSettings.resolve(organizationId);
    if (!credentials) throw notConfigured();
    const { packages } = await this.listPackages(organizationId);
    const selected = findPackageByCredits(packages, credits);
    if (!selected) {
      throw new IdentityApplicationError("INVALID_CREDIT_PACKAGE", "That credit package is not available.");
    }

    const order = await this.prisma.creditPurchaseOrder.create({
      data: {
        organizationId,
        createdBy: userId,
        credits: selected.credits,
        amountMinor: selected.amountMinor,
        currency: selected.currency,
        status: "PENDING",
        gateway: "RAZORPAY"
      }
    });

    try {
      const gatewayOrder = await this.razorpay.createOrder(credentials, {
        amountMinor: selected.amountMinor,
        currency: selected.currency,
        receipt: order.id
      });
      const updated = await this.prisma.creditPurchaseOrder.update({
        where: { id: order.id },
        data: { gatewayOrderId: gatewayOrder.id }
      });
      return {
        id: updated.id,
        credits: updated.credits,
        amountMinor: updated.amountMinor,
        currency: updated.currency,
        status: updated.status,
        gatewayOrderId: updated.gatewayOrderId,
        razorpayKeyId: credentials.keyId
      };
    } catch (error) {
      await this.prisma.creditPurchaseOrder.update({
        where: { id: order.id },
        data: {
          status: "FAILED",
          failureReason: error instanceof Error ? error.message.slice(0, 300) : "Unknown gateway error"
        }
      });
      throw error;
    }
  }

  /**
   * Confirms a checkout success callback. The client's own "it worked" claim is never trusted — the
   * signature is re-derived server-side from the account's key_secret (see RazorpayService.verifySignature)
   * before this order is marked PAID or any credit is granted. Only on that verified success does this
   * increase the organization's allowance for the CURRENT billing cycle — there is no separate purchased-
   * credit wallet in this system, so a top-up is modeled as raising `monthlyCreditAllowanceOverride`, the
   * same field BillingService.summary already reads as the effective allowance.
   */
  async verifyPayment(
    organizationId: string,
    orderId: string,
    payload: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }
  ): Promise<{ status: string; credits: number }> {
    const order = await this.prisma.creditPurchaseOrder.findFirst({ where: { id: orderId, organizationId } });
    if (!order) {
      throw new IdentityApplicationError("CREDIT_PURCHASE_ORDER_NOT_FOUND", "This purchase order was not found.");
    }
    if (order.status === "PAID") return { status: order.status, credits: order.credits };
    if (order.status !== "PENDING") {
      throw new IdentityApplicationError(
        "CREDIT_PURCHASE_ORDER_NOT_PENDING",
        "This purchase order is no longer pending payment."
      );
    }
    if (order.gatewayOrderId !== payload.razorpayOrderId) {
      throw new IdentityApplicationError(
        "CREDIT_PURCHASE_ORDER_MISMATCH",
        "The payment does not match this purchase order."
      );
    }

    const credentials = await this.paymentSettings.resolve(organizationId);
    if (!credentials) throw notConfigured();
    const verified = this.razorpay.verifySignature(credentials, {
      orderId: payload.razorpayOrderId,
      paymentId: payload.razorpayPaymentId,
      signature: payload.razorpaySignature
    });

    if (!verified) {
      await this.prisma.creditPurchaseOrder.update({
        where: { id: order.id },
        data: { status: "FAILED", failureReason: "Signature verification failed" }
      });
      throw new IdentityApplicationError("PAYMENT_SIGNATURE_INVALID", "We couldn't verify this payment.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.creditPurchaseOrder.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          gatewayPaymentId: payload.razorpayPaymentId,
          paidAt: new Date()
        }
      });
      const sub = await tx.organisationSubscription.findUnique({ where: { organizationId }, include: { plan: true } });
      if (sub) {
        const currentAllowance = sub.monthlyCreditAllowanceOverride ?? sub.plan.monthlyCreditAllowance;
        await tx.organisationSubscription.update({
          where: { organizationId },
          data: { monthlyCreditAllowanceOverride: currentAllowance + order.credits }
        });
      }
    });

    return { status: "PAID", credits: order.credits };
  }
}
