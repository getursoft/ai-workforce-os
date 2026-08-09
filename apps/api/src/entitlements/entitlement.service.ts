import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { DEFAULT_ENTITLEMENTS, type EntitlementValue, type FeatureKey, type ResolvedEntitlements } from "./entitlement.types";

const COUNTABLE_FEATURES: Partial<Record<FeatureKey, true>> = {
  MAX_EMPLOYEES: true,
  MAX_USERS: true,
  MAX_WHATSAPP_CHANNELS: true,
  MAX_SCHEDULED_JOBS: true,
  SKILLS_MAX_INSTALLED: true
};

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveEntitlements(organizationId: string): Promise<ResolvedEntitlements> {
    const resolved: ResolvedEntitlements = { ...DEFAULT_ENTITLEMENTS };

    const sub = await this.prisma.organisationSubscription.findUnique({ where: { organizationId }, include: { plan: true } });
    if (sub) {
      const planEntitlements = this.parsePlanEntitlements(sub.plan.metadataJson);
      for (const [key, value] of Object.entries(planEntitlements)) {
        if (value !== undefined && this.isFeatureKey(key)) resolved[key] = value;
      }
      // The plan's dedicated activeEmployeeLimit column takes priority over metadataJson.entitlements —
      // it's the field administrators actually edit for this specific limit today (billing.controller.ts
      // already surfaces it), so it must win over a JSON blob that could drift out of sync with it.
      if (sub.plan.activeEmployeeLimit !== null && sub.plan.activeEmployeeLimit !== undefined) {
        resolved.MAX_EMPLOYEES = sub.plan.activeEmployeeLimit;
      }
    }

    const flags = await this.prisma.featureFlag.findMany({ where: { organizationId } });
    for (const flag of flags) {
      if (!this.isFeatureKey(flag.key)) continue;
      const value = this.parseFlagValue(flag.key, flag.enabled, flag.value);
      if (value !== undefined) resolved[flag.key] = value;
    }

    return resolved;
  }

  async getLimit(organizationId: string, key: FeatureKey): Promise<number> {
    const entitlements = await this.resolveEntitlements(organizationId);
    const value = entitlements[key];
    return typeof value === "number" ? value : value ? Number.POSITIVE_INFINITY : 0;
  }

  async assertFeature(organizationId: string, key: FeatureKey): Promise<void> {
    const entitlements = await this.resolveEntitlements(organizationId);
    const value = entitlements[key];
    const allowed = typeof value === "boolean" ? value : value > 0;
    if (!allowed) {
      this.logger.warn({ event: "ENTITLEMENT_FEATURE_BLOCKED", organizationId, key });
      throw new IdentityApplicationError("ENTITLEMENT_FEATURE_NOT_AVAILABLE", `The "${key}" feature is not available on this organization's plan.`);
    }
  }

  /** Throws ENTITLEMENT_LIMIT_REACHED if adding `additional` more of `key` would exceed the resolved
   *  limit. Read-only: like BillingEnforcementService, there's no separate reservation ledger — capacity
   *  is counted live from the actual rows (installed employees, active users, etc.), so it can never
   *  drift from what's really there. */
  async consumeCapacity(organizationId: string, key: FeatureKey, additional = 1): Promise<void> {
    if (!COUNTABLE_FEATURES[key]) return;
    const [limit, used] = await Promise.all([this.getLimit(organizationId, key), this.getUsage(organizationId, key)]);
    if (used + additional > limit) {
      this.logger.warn({ event: "ENTITLEMENT_LIMIT_BLOCKED", organizationId, key, limit, used, additional });
      throw new IdentityApplicationError("ENTITLEMENT_LIMIT_REACHED", `This organization has reached its plan limit for "${key}" (${used}/${limit}).`);
    }
  }

  async getUsage(organizationId: string, key: FeatureKey): Promise<number> {
    switch (key) {
      case "MAX_EMPLOYEES":
        return this.prisma.plugin.count({ where: { organizationId, deletedAt: null, status: "ACTIVE" } });
      case "MAX_USERS":
        return this.prisma.user.count({ where: { organizationId, status: "ACTIVE" } });
      case "MAX_WHATSAPP_CHANNELS":
        return this.prisma.channelConnection.count({ where: { organizationId, status: { not: "DISABLED" } } });
      case "MAX_SCHEDULED_JOBS":
        return this.prisma.scheduledJob.count({ where: { organizationId, status: { in: ["ACTIVE", "PAUSED"] } } });
      case "SKILLS_MAX_INSTALLED":
        return this.prisma.skillInstallation.count({ where: { organizationId, deletedAt: null } });
      default:
        return 0;
    }
  }

  private isFeatureKey(key: string): key is FeatureKey {
    return key in DEFAULT_ENTITLEMENTS;
  }

  private parsePlanEntitlements(metadataJson: unknown): Partial<Record<string, EntitlementValue>> {
    if (!metadataJson || typeof metadataJson !== "object" || Array.isArray(metadataJson)) return {};
    const entitlements = (metadataJson as Record<string, unknown>).entitlements;
    if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) return {};
    const out: Partial<Record<string, EntitlementValue>> = {};
    for (const [key, value] of Object.entries(entitlements as Record<string, unknown>)) {
      if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    }
    return out;
  }

  private parseFlagValue(key: FeatureKey, enabled: boolean, valueJson: unknown): EntitlementValue | undefined {
    const defaultIsBoolean = typeof DEFAULT_ENTITLEMENTS[key] === "boolean";
    if (defaultIsBoolean) return enabled;
    if (valueJson && typeof valueJson === "object" && !Array.isArray(valueJson)) {
      const limit = (valueJson as Record<string, unknown>).limit;
      if (typeof limit === "number") return limit;
    }
    return undefined;
  }
}
