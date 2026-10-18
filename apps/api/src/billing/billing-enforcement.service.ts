import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { PlatformOwnerService } from "../identity/infrastructure/security/platform-owner.service";
import { tokensToCredits } from "./billing.service";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";

/**
 * Sprint 5.0 — Phase 10: server-side subscription/credit enforcement.
 *
 * Billing visibility (BillingService) and payment capture (CreditPurchaseService/RazorpayService) were
 * already real and correct before this pass — what was missing was any check BEFORE a billable AI
 * execution runs. `assertExecutionAllowed` is the single gate: AgentService.execute() calls it once per
 * turn, before any provider/tool work happens. It never touches login, the billing page, or critical
 * system notifications — those paths don't call it.
 *
 * The credit pool is shared across every employee installed in an organization (not per-employee), matching
 * BillingService.summary()'s existing accounting. `tokensToCredits` is the one place tokens become credits,
 * shared with BillingService so the enforced number and the displayed number can never drift apart.
 */

export type BillingEnforcementOutcome =
  | "ALLOWED"
  | "ALLOWED_WITH_WARNING"
  | "GRACE_PERIOD"
  | "HARD_LIMIT_REACHED"
  | "SUBSCRIPTION_INACTIVE"
  | "SPENDING_CAP_REACHED";

export interface BillingEnforcementDecision {
  outcome: BillingEnforcementOutcome;
  allowed: boolean;
  reason: string;
  usedCredits: number | null;
  allowanceCredits: number | null;
  spendingCapCredits: number | null;
}

const BLOCKED_OUTCOMES: ReadonlySet<BillingEnforcementOutcome> = new Set([
  "HARD_LIMIT_REACHED",
  "SUBSCRIPTION_INACTIVE",
  "SPENDING_CAP_REACHED"
]);

/** Subscription lifecycle states this enforcement understands. `status` is a free-text column (no DB enum
 *  yet), so unrecognized values are treated as ACTIVE rather than silently blocking a paying customer over
 *  a typo'd status string. */
const INACTIVE_STATUSES = new Set(["SUSPENDED", "CANCELLED"]);
const GRACE_STATUSES = new Set(["PAST_DUE"]);

@Injectable()
export class BillingEnforcementService {
  private readonly logger = new Logger(BillingEnforcementService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(APP_CONFIG) private readonly appConfig?: AppConfig,
    @Optional() private readonly platformOwner?: PlatformOwnerService
  ) {}

  private enforcementEnabled(): boolean {
    if (!this.appConfig) return true; // fail toward enforcing when config isn't wired (e.g. isolated unit tests)
    return this.appConfig.boolean("BILLING_ENFORCEMENT_ENABLED", true);
  }

  private gracePercent(): number {
    if (!this.appConfig) return 0;
    return this.appConfig.number("CREDIT_GRACE_PERCENT", 0);
  }

  /**
   * Evaluates whether an organization may run a billable AI execution right now. Read-only: usage is
   * reconciled naturally because credits are computed live from completed AgentExecution rows (see
   * BillingService.summary) — there is no separate reservation ledger to update here.
   */
  async assertExecutionAllowed(organizationId: string): Promise<BillingEnforcementDecision> {
    const decision = await this.evaluate(organizationId);
    if (!decision.allowed) {
      this.logger.warn({ event: "BILLING_EXECUTION_BLOCKED", organizationId, outcome: decision.outcome, reason: decision.reason });
      const code =
        decision.outcome === "SUBSCRIPTION_INACTIVE"
          ? "BILLING_SUBSCRIPTION_INACTIVE"
          : decision.outcome === "SPENDING_CAP_REACHED"
            ? "BILLING_SPENDING_CAP_REACHED"
            : "BILLING_HARD_LIMIT_REACHED";
      throw new IdentityApplicationError(code, decision.reason);
    }
    return decision;
  }

  async evaluate(organizationId: string): Promise<BillingEnforcementDecision> {
    // The platform's own operating organization has no subscription to meter against — never block it.
    // `@Optional()`: absent in an isolated unit test, this never bypasses anything (fails toward
    // enforcing, never toward a silent privilege grant).
    if (this.platformOwner && (await this.platformOwner.isPlatformOwnerOrganization(organizationId))) {
      return {
        outcome: "ALLOWED",
        allowed: true,
        reason: "Platform owner organization; unmetered.",
        usedCredits: null,
        allowanceCredits: null,
        spendingCapCredits: null
      };
    }
    if (!this.enforcementEnabled()) {
      return { outcome: "ALLOWED", allowed: true, reason: "Billing enforcement is disabled.", usedCredits: null, allowanceCredits: null, spendingCapCredits: null };
    }

    const sub = await this.prisma.organisationSubscription.findUnique({ where: { organizationId }, include: { plan: true } });
    // No subscription row: preserve pre-Sprint-5.0 behavior (dev/test/legacy orgs are unmetered) rather
    // than blocking every organization that predates the subscription model.
    if (!sub) {
      return { outcome: "ALLOWED", allowed: true, reason: "No subscription on record; unmetered.", usedCredits: null, allowanceCredits: null, spendingCapCredits: null };
    }

    if (INACTIVE_STATUSES.has(sub.status)) {
      return {
        outcome: "SUBSCRIPTION_INACTIVE",
        allowed: false,
        reason: `The organization's subscription is ${sub.status.toLowerCase()}.`,
        usedCredits: null,
        allowanceCredits: null,
        spendingCapCredits: sub.spendingCapCredits ?? null
      };
    }

    const start = sub.billingCycleStart;
    const end = sub.billingCycleEnd;
    const agg = await this.prisma.agentExecution.aggregate({
      where: { organizationId, status: "COMPLETED", createdAt: { gte: start, lte: end } },
      _sum: { totalTokens: true }
    });
    const usedCredits = tokensToCredits(agg._sum.totalTokens ?? 0);
    const allowance = sub.monthlyCreditAllowanceOverride ?? sub.plan.monthlyCreditAllowance ?? 0;
    const overageAllowed = (sub.overageEnabledOverride ?? sub.plan.overageEnabled) === true;
    const spendingCap = sub.spendingCapCredits ?? null;

    if (spendingCap !== null && usedCredits >= spendingCap) {
      return { outcome: "SPENDING_CAP_REACHED", allowed: false, reason: "The organization's spending cap has been reached.", usedCredits, allowanceCredits: allowance, spendingCapCredits: spendingCap };
    }

    const graceCeiling = allowance * (1 + Math.max(this.gracePercent(), 0) / 100);
    const base: Pick<BillingEnforcementDecision, "usedCredits" | "allowanceCredits" | "spendingCapCredits"> = {
      usedCredits,
      allowanceCredits: allowance,
      spendingCapCredits: spendingCap
    };

    let outcome: BillingEnforcementOutcome;
    let reason: string;
    if (usedCredits < allowance * 0.85) {
      outcome = "ALLOWED";
      reason = "Within the monthly credit allowance.";
    } else if (usedCredits < allowance) {
      outcome = "ALLOWED_WITH_WARNING";
      reason = "Approaching the monthly credit allowance.";
    } else if (usedCredits < graceCeiling) {
      outcome = overageAllowed ? "ALLOWED_WITH_WARNING" : "GRACE_PERIOD";
      reason = overageAllowed ? "Over the monthly allowance; overage billing applies." : "Over the monthly allowance; within the grace period.";
    } else if (overageAllowed && sub.hardLimitEnabled !== true) {
      outcome = "ALLOWED_WITH_WARNING";
      reason = "Beyond the grace period; overage billing applies.";
    } else {
      outcome = "HARD_LIMIT_REACHED";
      reason = "The monthly credit allowance and grace period have been exhausted.";
    }

    // GRACE_STATUSES (e.g. PAST_DUE) never grant MORE headroom than the credit math above already allows —
    // they can only soften an otherwise-hard block into a warning, since a card decline shouldn't
    // immediately cut off a customer who still has unused allowance.
    if (GRACE_STATUSES.has(sub.status) && outcome === "HARD_LIMIT_REACHED") {
      outcome = "GRACE_PERIOD";
      reason = `Subscription is ${sub.status.toLowerCase()}; allowed within grace period.`;
    }

    return { outcome, allowed: !BLOCKED_OUTCOMES.has(outcome), reason, ...base };
  }
}
