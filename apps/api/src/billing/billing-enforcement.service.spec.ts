import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { AppConfig } from "../config/config.tokens";
import { BillingEnforcementService } from "./billing-enforcement.service";

const CYCLE_START = new Date("2026-07-01T00:00:00.000Z");
const CYCLE_END = new Date("2026-07-31T23:59:59.999Z");

function makePrisma(sub: Record<string, unknown> | null, totalTokens: number) {
  return {
    organisationSubscription: { findUnique: vi.fn().mockResolvedValue(sub) },
    agentExecution: { aggregate: vi.fn().mockResolvedValue({ _sum: { totalTokens } }) }
  } as unknown as PrismaService;
}

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const values: Record<string, unknown> = { BILLING_ENFORCEMENT_ENABLED: true, CREDIT_GRACE_PERCENT: 0, ...overrides };
  return {
    boolean: (name: string, fallback = false) => (values[name] as boolean) ?? fallback,
    number: (name: string, fallback = 0) => (values[name] as number) ?? fallback,
    string: (name: string, fallback = "") => (values[name] as string) ?? fallback,
    get: (name: string) => (values[name] as string | number | boolean | null) ?? null,
    runs: () => true,
    startupSummary: () => "",
    processRole: "all",
    productionLike: false,
    security: {} as never
  } as AppConfig;
}

function plan(over: Partial<{ monthlyCreditAllowance: number; overageEnabled: boolean }> = {}) {
  return { monthlyCreditAllowance: 1000, overageEnabled: false, ...over };
}

describe("BillingEnforcementService.evaluate", () => {
  it("allows execution when there is no subscription on record (unmetered dev/legacy orgs)", async () => {
    const service = new BillingEnforcementService(makePrisma(null, 0), makeConfig());
    const decision = await service.evaluate("org-1");
    expect(decision).toEqual({ outcome: "ALLOWED", allowed: true, reason: expect.any(String), usedCredits: null, allowanceCredits: null, spendingCapCredits: null });
  });

  it("skips all checks when BILLING_ENFORCEMENT_ENABLED=false", async () => {
    const service = new BillingEnforcementService(
      makePrisma({ status: "SUSPENDED", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 999_999),
      makeConfig({ BILLING_ENFORCEMENT_ENABLED: false })
    );
    const decision = await service.evaluate("org-1");
    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe("ALLOWED");
  });

  it("blocks a SUSPENDED subscription regardless of remaining credits", async () => {
    const service = new BillingEnforcementService(
      makePrisma({ status: "SUSPENDED", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 0),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "SUBSCRIPTION_INACTIVE", allowed: false });
  });

  it("blocks a CANCELLED subscription", async () => {
    const service = new BillingEnforcementService(
      makePrisma({ status: "CANCELLED", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 0),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision.outcome).toBe("SUBSCRIPTION_INACTIVE");
  });

  it("allows well within the monthly allowance", async () => {
    // 1000 tokens -> ceil(1000*4/1000) = 4 credits, far under an 1000-credit allowance.
    const service = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 1000),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "ALLOWED", allowed: true, usedCredits: 4, allowanceCredits: 1000 });
  });

  it("warns when past 85% of the allowance but still allows execution", async () => {
    // Allowance 1000, want usedCredits ~900 -> totalTokens = 900*1000/4 = 225000.
    const service = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 225_000),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "ALLOWED_WITH_WARNING", allowed: true });
  });

  it("blocks with HARD_LIMIT_REACHED once the allowance and grace period are exhausted and overage is disabled", async () => {
    // Allowance 1000, no grace, no overage -> anything >= 1000 credits blocks.
    const service = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, hardLimitEnabled: true, plan: plan() }, 300_000),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "HARD_LIMIT_REACHED", allowed: false });
  });

  it("allows over-allowance usage with a warning when the plan permits overage billing", async () => {
    const service = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan({ overageEnabled: true }) }, 300_000),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "ALLOWED_WITH_WARNING", allowed: true });
  });

  it("respects an absolute spending cap even when overage is otherwise enabled", async () => {
    const service = new BillingEnforcementService(
      makePrisma(
        { status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, spendingCapCredits: 500, plan: plan({ overageEnabled: true }) },
        300_000
      ),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "SPENDING_CAP_REACHED", allowed: false, spendingCapCredits: 500 });
  });

  it("softens a PAST_DUE org's HARD_LIMIT_REACHED into GRACE_PERIOD rather than an immediate cutoff", async () => {
    const service = new BillingEnforcementService(
      makePrisma({ status: "PAST_DUE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, hardLimitEnabled: true, plan: plan() }, 300_000),
      makeConfig()
    );
    const decision = await service.evaluate("org-1");
    expect(decision).toMatchObject({ outcome: "GRACE_PERIOD", allowed: true });
  });

  it("extends the effective ceiling by CREDIT_GRACE_PERCENT before treating usage as over-allowance", async () => {
    // Allowance 1000, grace 50% -> ceiling 1500 credits. 1100 credits should land in GRACE_PERIOD, not blocked.
    const service = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 275_000),
      makeConfig({ CREDIT_GRACE_PERCENT: 50 })
    );
    const decision = await service.evaluate("org-1");
    expect(decision.outcome).toBe("GRACE_PERIOD");
    expect(decision.allowed).toBe(true);
  });

  it("assertExecutionAllowed throws a typed, mapped error when blocked, and resolves silently when allowed", async () => {
    const blocked = new BillingEnforcementService(
      makePrisma({ status: "SUSPENDED", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 0),
      makeConfig()
    );
    await expect(blocked.assertExecutionAllowed("org-1")).rejects.toMatchObject({ code: "BILLING_SUBSCRIPTION_INACTIVE" });

    const allowed = new BillingEnforcementService(
      makePrisma({ status: "ACTIVE", billingCycleStart: CYCLE_START, billingCycleEnd: CYCLE_END, plan: plan() }, 0),
      makeConfig()
    );
    await expect(allowed.assertExecutionAllowed("org-1")).resolves.toMatchObject({ outcome: "ALLOWED" });
  });
});
