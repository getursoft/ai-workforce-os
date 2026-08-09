import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EntitlementService } from "./entitlement.service";

function makePrisma(input: {
  sub?: { plan: { metadataJson?: unknown; activeEmployeeLimit?: number | null }; status?: string } | null;
  flags?: Array<{ key: string; enabled: boolean; value: unknown }>;
  pluginCount?: number;
  userCount?: number;
  channelCount?: number;
  jobCount?: number;
}) {
  return {
    organisationSubscription: { findUnique: vi.fn().mockResolvedValue(input.sub ?? null) },
    featureFlag: { findMany: vi.fn().mockResolvedValue(input.flags ?? []) },
    plugin: { count: vi.fn().mockResolvedValue(input.pluginCount ?? 0) },
    user: { count: vi.fn().mockResolvedValue(input.userCount ?? 0) },
    channelConnection: { count: vi.fn().mockResolvedValue(input.channelCount ?? 0) },
    scheduledJob: { count: vi.fn().mockResolvedValue(input.jobCount ?? 0) }
  } as unknown as PrismaService;
}

describe("EntitlementService", () => {
  it("falls back to the generous default entitlements when there is no subscription row", async () => {
    const service = new EntitlementService(makePrisma({}));
    const entitlements = await service.resolveEntitlements("org-1");
    expect(entitlements.MAX_EMPLOYEES).toBe(10);
    expect(entitlements.SSO).toBe(false);
  });

  it("applies plan-tier overrides from SubscriptionPlan.metadataJson.entitlements", async () => {
    const service = new EntitlementService(
      makePrisma({ sub: { plan: { metadataJson: { entitlements: { MAX_EMPLOYEES: 2, SSO: true } }, activeEmployeeLimit: null } } })
    );
    const entitlements = await service.resolveEntitlements("org-1");
    expect(entitlements.MAX_EMPLOYEES).toBe(2);
    expect(entitlements.SSO).toBe(true);
    // Untouched keys keep their default.
    expect(entitlements.MAX_USERS).toBe(25);
  });

  it("the plan's dedicated activeEmployeeLimit column wins over metadataJson.entitlements.MAX_EMPLOYEES", async () => {
    const service = new EntitlementService(
      makePrisma({ sub: { plan: { metadataJson: { entitlements: { MAX_EMPLOYEES: 2 } }, activeEmployeeLimit: 7 } } })
    );
    const entitlements = await service.resolveEntitlements("org-1");
    expect(entitlements.MAX_EMPLOYEES).toBe(7);
  });

  it("an org-specific FeatureFlag overrides everything else, for both boolean and numeric-limit features", async () => {
    const service = new EntitlementService(
      makePrisma({
        sub: { plan: { metadataJson: { entitlements: { MAX_EMPLOYEES: 2 } }, activeEmployeeLimit: null } },
        flags: [
          { key: "MAX_EMPLOYEES", enabled: true, value: { limit: 50 } },
          { key: "SSO", enabled: true, value: {} }
        ]
      })
    );
    const entitlements = await service.resolveEntitlements("org-1");
    expect(entitlements.MAX_EMPLOYEES).toBe(50);
    expect(entitlements.SSO).toBe(true);
  });

  it("assertFeature throws ENTITLEMENT_FEATURE_NOT_AVAILABLE for a disabled boolean feature", async () => {
    const service = new EntitlementService(makePrisma({}));
    await expect(service.assertFeature("org-1", "SSO")).rejects.toMatchObject({ code: "ENTITLEMENT_FEATURE_NOT_AVAILABLE" });
    await expect(service.assertFeature("org-1", "API_ACCESS")).resolves.toBeUndefined();
  });

  it("consumeCapacity allows right up to the limit and blocks the request that would exceed it", async () => {
    const atLimit = new EntitlementService(
      makePrisma({ sub: { plan: { metadataJson: { entitlements: { MAX_EMPLOYEES: 3 } }, activeEmployeeLimit: null } }, pluginCount: 2 })
    );
    await expect(atLimit.consumeCapacity("org-1", "MAX_EMPLOYEES")).resolves.toBeUndefined(); // 2 + 1 = 3, allowed

    const overLimit = new EntitlementService(
      makePrisma({ sub: { plan: { metadataJson: { entitlements: { MAX_EMPLOYEES: 3 } }, activeEmployeeLimit: null } }, pluginCount: 3 })
    );
    await expect(overLimit.consumeCapacity("org-1", "MAX_EMPLOYEES")).rejects.toMatchObject({ code: "ENTITLEMENT_LIMIT_REACHED" }); // 3 + 1 = 4, blocked
  });

  it("consumeCapacity is a no-op for a non-countable (boolean) feature", async () => {
    const service = new EntitlementService(makePrisma({}));
    await expect(service.consumeCapacity("org-1", "SSO")).resolves.toBeUndefined();
  });

  it("getUsage counts active employees/users/channels/jobs from the real tables, not a cached number", async () => {
    const service = new EntitlementService(makePrisma({ pluginCount: 4, userCount: 9, channelCount: 1, jobCount: 6 }));
    expect(await service.getUsage("org-1", "MAX_EMPLOYEES")).toBe(4);
    expect(await service.getUsage("org-1", "MAX_USERS")).toBe(9);
    expect(await service.getUsage("org-1", "MAX_WHATSAPP_CHANNELS")).toBe(1);
    expect(await service.getUsage("org-1", "MAX_SCHEDULED_JOBS")).toBe(6);
  });
});
