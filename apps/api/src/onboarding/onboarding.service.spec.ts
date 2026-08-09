import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { EntitlementService } from "../entitlements/entitlement.service";
import { OnboardingService } from "./onboarding.service";

function makeDeps(usage: Record<string, number>, counts: Partial<Record<string, number>> = {}) {
  const prisma = {
    knowledgeDocument: { count: vi.fn().mockResolvedValue(counts.knowledgeDocument ?? 0) },
    organisationSubscription: { count: vi.fn().mockResolvedValue(counts.organisationSubscription ?? 0) },
    agentExecution: { count: vi.fn().mockResolvedValue(counts.agentExecution ?? 0) },
    pluginAiConfiguration: { count: vi.fn().mockResolvedValue(counts.pluginAiConfiguration ?? 0) }
  } as unknown as PrismaService;
  const entitlements = {
    getUsage: vi.fn((_org: string, key: string) => Promise.resolve(usage[key] ?? 0))
  } as unknown as EntitlementService;
  return { prisma, entitlements };
}

describe("OnboardingService.checklist", () => {
  it("reports nothing complete for a brand-new organization", async () => {
    const { prisma, entitlements } = makeDeps({});
    const service = new OnboardingService(prisma, entitlements);
    const result = await service.checklist("org-1");
    expect(result.completedCount).toBe(0);
    expect(result.percentComplete).toBe(0);
    expect(result.totalCount).toBe(7);
  });

  it("marks items complete as real state accumulates, and computes a correct percentage", async () => {
    const { prisma, entitlements } = makeDeps(
      { MAX_EMPLOYEES: 2, MAX_WHATSAPP_CHANNELS: 1, MAX_USERS: 3 },
      { knowledgeDocument: 5, agentExecution: 1, organisationSubscription: 1 }
    );
    const service = new OnboardingService(prisma, entitlements);
    const result = await service.checklist("org-1");
    expect(result.completedCount).toBe(7);
    expect(result.percentComplete).toBe(100);
    expect(result.items.find((i) => i.key === "EMPLOYEE_INSTALLED")?.complete).toBe(true);
    expect(result.items.find((i) => i.key === "TEAM_INVITED")?.complete).toBe(true);
  });

  it("TEAM_INVITED requires more than just the owner (users > 1, not >= 1)", async () => {
    const { prisma, entitlements } = makeDeps({ MAX_USERS: 1 });
    const service = new OnboardingService(prisma, entitlements);
    const result = await service.checklist("org-1");
    expect(result.items.find((i) => i.key === "TEAM_INVITED")?.complete).toBe(false);
  });
});
