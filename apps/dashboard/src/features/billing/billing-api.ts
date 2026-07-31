import type { ApiClient } from "../../lib/api-client";

export interface UsageSummary {
  plan: { code: string; name: string } | null;
  billingCycle: { start: string; end: string } | null;
  currency: string;
  monthlyAllowanceCredits: number;
  usedCredits: number;
  remainingCredits: number;
  usagePercentage: number;
  estimatedOverageAmountMinor: number;
  threshold: "NORMAL" | "INFORMATIONAL" | "WARNING" | "LIMIT_REACHED" | "OVERAGE";
  tokens: { input: number; output: number; cachedInput: number; reasoning: number; total: number };
  totalRequests: number;
}

export interface EmployeeUsage {
  pluginInstallationId: string;
  employeeName: string;
  creditsConsumed: number;
  sharePercentage: number;
  inputTokens: number;
  outputTokens: number;
  executions: number;
}

export interface CapabilityUsage {
  capability: string;
  displayName: string;
  creditsConsumed: number;
  sharePercentage: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  creditsConsumed: number;
  internalCostAmountMinor: number | null;
}

export interface TrendPoint {
  date: string;
  creditsConsumed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UserUsage {
  userId: string;
  name: string;
  email: string;
  creditsConsumed: number;
  sharePercentage: number;
  inputTokens: number;
  outputTokens: number;
  executions: number;
}

export interface CreditPackage {
  credits: number;
  amountMinor: number;
  currency: string;
}

export interface CreditPurchaseOrder {
  id: string;
  credits: number;
  amountMinor: number;
  currency: string;
  status: string;
  gatewayOrderId: string | null;
  razorpayKeyId: string;
}

export interface PaymentSettings {
  configured: boolean;
  keyId: string | null;
  keySecret: { configured: boolean; updatedAt: string | null };
  updatedAt: string | null;
}

export interface UpdatePaymentSettingsInput {
  keyId?: string;
  keySecret?: string;
  removeSecrets?: string[];
}

function qs(start?: string, end?: string): string {
  return start && end ? `?start=${start}&end=${end}` : "";
}

export function createBillingApi(client: ApiClient) {
  return {
    summary: (start?: string, end?: string) =>
      client.request<UsageSummary>(`/billing/usage/summary${qs(start, end)}`),
    byEmployee: (start?: string, end?: string) =>
      client.request<EmployeeUsage[]>(`/billing/usage/by-employee${qs(start, end)}`),
    byCapability: (start?: string, end?: string) =>
      client.request<CapabilityUsage[]>(`/billing/usage/by-capability${qs(start, end)}`),
    byModel: (start?: string, end?: string) =>
      client.request<ModelUsage[]>(`/billing/usage/by-model${qs(start, end)}`),
    trend: (start?: string, end?: string) =>
      client.request<TrendPoint[]>(`/billing/usage/trend${qs(start, end)}`),
    byUser: (start?: string, end?: string) =>
      client.request<UserUsage[]>(`/billing/usage/by-user${qs(start, end)}`),
    creditPackages: () =>
      client.request<{ currency: string; packages: CreditPackage[] }>("/billing/credit-purchase/packages"),
    createCreditPurchaseOrder: (credits: number) =>
      client.request<CreditPurchaseOrder>("/billing/credit-purchase/orders", {
        method: "POST",
        body: JSON.stringify({ credits })
      }),
    verifyCreditPurchaseOrder: (
      orderId: string,
      body: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }
    ) =>
      client.request<{ status: string; credits: number }>(`/billing/credit-purchase/orders/${orderId}/verify`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    paymentSettings: () => client.request<PaymentSettings>("/billing/payment-settings"),
    updatePaymentSettings: (body: UpdatePaymentSettingsInput) =>
      client.request<PaymentSettings>("/billing/payment-settings", {
        method: "PUT",
        body: JSON.stringify(body)
      })
  };
}
