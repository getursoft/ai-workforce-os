import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { PluginSecretsEncryptionService } from "./plugin.runtime";
import { PluginService } from "./plugin.service";

const encryption = new PluginSecretsEncryptionService(crypto.randomBytes(32));

type MockPrisma = {
  employeeRoutingProfile: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  plugin: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function mockPrisma(plugins: Array<Record<string, unknown>> = [], existingProfile?: Record<string, unknown>): MockPrisma {
  const profiles: Map<string, Record<string, unknown>> = new Map();
  if (existingProfile) profiles.set(existingProfile.pluginInstallationId as string, existingProfile);
  return {
    employeeRoutingProfile: {
      findUnique: vi.fn(({ where }: { where: Record<string, unknown> }) => profiles.get(where.pluginInstallationId as string) ?? null),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const pid = data.pluginInstallationId as string;
        if (profiles.has(pid)) { const e = new Error("unique") as Error & { code: string }; e.code = "P2002"; throw e; }
        const profile = { id: "profile-1", ...data, createdAt: new Date(), updatedAt: new Date() };
        profiles.set(pid, profile);
        return profile;
      })
    },
    plugin: { findMany: vi.fn().mockResolvedValue(plugins) },
    $transaction: vi.fn((cb: (tx: MockPrisma) => unknown) => cb({ employeeRoutingProfile: { create: vi.fn(), findUnique: vi.fn() } } as never))
  };
}

describe("EmployeeRoutingProfile lifecycle", () => {
  it("creates a profile when plugin has no profile (backfill)", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "travel-employee", displayName: "Travel Employee", description: "Plan trips and hotels", status: "ACTIVE", deletedAt: null, manifest: {} };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    const count = await service.backfillRoutingProfiles();
    expect(count).toBe(1);
    expect(prisma.employeeRoutingProfile.create).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing profile", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "travel-employee", displayName: "Travel Employee", description: "Plan trips", status: "ACTIVE", deletedAt: null, manifest: {} };
    const existing = { pluginInstallationId: "p1", displayName: "Admin Custom" };
    const prisma = mockPrisma([plugin], existing);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    const count = await service.backfillRoutingProfiles();
    expect(count).toBe(0);
    expect(prisma.employeeRoutingProfile.create).not.toHaveBeenCalled();
  });

  it("generates travel defaults from slug matching", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "travel-employee", displayName: "Travel Employee", description: "Plan trips and hotels", status: "ACTIVE", deletedAt: null, manifest: {} };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.displayName).toBe("Travel Employee");
    expect(callArg?.data.routingKeywords).toContain("travel");
  });

  it("uses manifest routing metadata when available", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "custom", displayName: "Custom Employee", description: "Custom help", status: "ACTIVE", deletedAt: null, manifest: { routing: { displayName: "Custom Name", summary: "Custom summary", supportedDomains: ["Custom Domain"] } } };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.displayName).toBe("Custom Name");
    expect(callArg?.data.summary).toBe("Custom summary");
    expect(callArg?.data.supportedDomains).toContain("Custom Domain");
  });

  it("generates conservative defaults when no slug match", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "unknown-employee", displayName: "Unknown Employee", description: "Generic help", status: "ACTIVE", deletedAt: null, manifest: {} };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.employeeType).toBeNull();
    expect(callArg?.data.supportedDomains).toEqual([]);
  });

  it("backfill is idempotent — running twice creates no duplicates", async () => {
    const plugin = { id: "p1", organizationId: "org-1", slug: "travel-employee", displayName: "Travel Employee", description: "Plan trips", status: "ACTIVE", deletedAt: null, manifest: {} };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(prisma as never, {} as never, {} as never, encryption, {} as never, {} as never, {} as never, { allowDevelopmentImplementations: true } as never);
    const count1 = await service.backfillRoutingProfiles();
    expect(count1).toBe(1);
    const count2 = await service.backfillRoutingProfiles();
    expect(count2).toBe(0);
    expect(prisma.employeeRoutingProfile.create).toHaveBeenCalledTimes(1);
  });
});
