import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { FeatureFlagService } from "./feature-flag.service";

function makePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    featureFlag: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
      ...overrides
    }
  } as unknown as PrismaService;
}

describe("FeatureFlagService", () => {
  it("defaults to disabled when no flag row exists at all", async () => {
    const service = new FeatureFlagService(makePrisma());
    expect(await service.isEnabled("REAL_WHATSAPP_OUTBOUND")).toBe(false);
    expect(await service.isEnabled("REAL_WHATSAPP_OUTBOUND", "org-1")).toBe(false);
  });

  it("falls back to the platform-wide flag when no org-specific override exists", async () => {
    const prisma = makePrisma({
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ enabled: true })
    });
    const service = new FeatureFlagService(prisma);
    expect(await service.isEnabled("REAL_EMAIL", "org-1")).toBe(true);
  });

  it("an org-specific override wins over the platform-wide default, in both directions", async () => {
    const enabledOverride = makePrisma({ findUnique: vi.fn().mockResolvedValue({ enabled: true }), findFirst: vi.fn().mockResolvedValue({ enabled: false }) });
    expect(await new FeatureFlagService(enabledOverride).isEnabled("BILLING_ENFORCEMENT", "org-1")).toBe(true);

    const disabledOverride = makePrisma({ findUnique: vi.fn().mockResolvedValue({ enabled: false }), findFirst: vi.fn().mockResolvedValue({ enabled: true }) });
    expect(await new FeatureFlagService(disabledOverride).isEnabled("BILLING_ENFORCEMENT", "org-1")).toBe(false);
  });

  it("setPlatformFlag creates when no platform row exists, updates when one does", async () => {
    const createPrisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    await new FeatureFlagService(createPrisma).setPlatformFlag("SCHEDULED_PROACTIVE_MESSAGES", true);
    expect(createPrisma.featureFlag.create).toHaveBeenCalledWith({
      data: { organizationId: null, key: "SCHEDULED_PROACTIVE_MESSAGES", enabled: true, description: null }
    });

    const updatePrisma = makePrisma({ findFirst: vi.fn().mockResolvedValue({ id: "flag-1" }) });
    await new FeatureFlagService(updatePrisma).setPlatformFlag("SCHEDULED_PROACTIVE_MESSAGES", false);
    expect(updatePrisma.featureFlag.update).toHaveBeenCalledWith({ where: { id: "flag-1" }, data: { enabled: false } });
  });

  it("setOrganizationFlag upserts keyed on the real (non-null) organizationId, safely", async () => {
    const prisma = makePrisma();
    await new FeatureFlagService(prisma).setOrganizationFlag("org-1", "AUTOMATIC_COLLABORATION", true, "pilot customer");
    expect(prisma.featureFlag.upsert).toHaveBeenCalledWith({
      where: { organizationId_key: { organizationId: "org-1", key: "AUTOMATIC_COLLABORATION" } },
      create: { organizationId: "org-1", key: "AUTOMATIC_COLLABORATION", enabled: true, description: "pilot customer" },
      update: { enabled: true, description: "pilot customer" }
    });
  });
});
