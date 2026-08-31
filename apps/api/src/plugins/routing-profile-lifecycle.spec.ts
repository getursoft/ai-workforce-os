import { describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { PluginSecretsEncryptionService } from "./plugin.runtime";
import { PluginService } from "./plugin.service";

const encryption = new PluginSecretsEncryptionService(crypto.randomBytes(32));

type MockPrisma = {
  employeeRoutingProfile: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  plugin: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function mockPrisma(
  plugins: Array<Record<string, unknown>> = [],
  existingProfile?: Record<string, unknown>
): MockPrisma {
  const profiles: Map<string, Record<string, unknown>> = new Map();
  if (existingProfile)
    profiles.set(existingProfile.pluginInstallationId as string, existingProfile);
  return {
    employeeRoutingProfile: {
      findUnique: vi.fn(
        ({ where }: { where: Record<string, unknown> }) =>
          profiles.get(where.pluginInstallationId as string) ?? null
      ),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const pid = data.pluginInstallationId as string;
        if (profiles.has(pid)) {
          const e = new Error("unique") as Error & { code: string };
          e.code = "P2002";
          throw e;
        }
        const profile = { id: "profile-1", ...data, createdAt: new Date(), updatedAt: new Date() };
        profiles.set(pid, profile);
        return profile;
      }),
      update: vi.fn(
        ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const pid = where.pluginInstallationId as string;
          const updated = { ...(profiles.get(pid) ?? {}), ...data };
          profiles.set(pid, updated);
          return updated;
        }
      )
    },
    plugin: { findMany: vi.fn().mockResolvedValue(plugins) },
    $transaction: vi.fn((cb: (tx: MockPrisma) => unknown) =>
      cb({ employeeRoutingProfile: { create: vi.fn(), findUnique: vi.fn() } } as never)
    )
  };
}

describe("EmployeeRoutingProfile lifecycle", () => {
  it("creates a profile when plugin has no profile (backfill)", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "travel-employee",
      displayName: "Travel Employee",
      description: "Plan trips and hotels",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    const count = await service.backfillRoutingProfiles();
    expect(count).toBe(1);
    expect(prisma.employeeRoutingProfile.create).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing profile", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "travel-employee",
      displayName: "Travel Employee",
      description: "Plan trips",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const existing = { pluginInstallationId: "p1", displayName: "Admin Custom" };
    const prisma = mockPrisma([plugin], existing);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    const count = await service.backfillRoutingProfiles();
    expect(count).toBe(0);
    expect(prisma.employeeRoutingProfile.create).not.toHaveBeenCalled();
  });

  it("uses a conservative slug alias when a legacy manifest has no routing metadata", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "travel-employee",
      displayName: "Travel Employee",
      description: "Plan trips and hotels",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.displayName).toBe("Travel Employee");
    expect(callArg?.data.employeeType).toBeNull();
    expect(callArg?.data.routingKeywords).toEqual(["travel-employee"]);
  });

  it("uses manifest routing metadata when available", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "custom",
      displayName: "Custom Employee",
      description: "Custom help",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {
        routing: {
          displayName: "Custom Name",
          summary: "Custom summary",
          supportedDomains: ["Custom Domain"]
        }
      }
    };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.displayName).toBe("Custom Name");
    expect(callArg?.data.summary).toBe("Custom summary");
    expect(callArg?.data.supportedDomains).toContain("Custom Domain");
  });

  it("generates conservative defaults when no slug match", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "unknown-employee",
      displayName: "Unknown Employee",
      description: "Generic help",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    await service.backfillRoutingProfiles();
    const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
    expect(callArg?.data.employeeType).toBeNull();
    expect(callArg?.data.supportedDomains).toEqual([]);
  });

  it("backfill is idempotent — running twice creates no duplicates", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "travel-employee",
      displayName: "Travel Employee",
      description: "Plan trips",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const prisma = mockPrisma([plugin]);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    const count1 = await service.backfillRoutingProfiles();
    expect(count1).toBe(1);
    const count2 = await service.backfillRoutingProfiles();
    expect(count2).toBe(0);
    expect(prisma.employeeRoutingProfile.create).toHaveBeenCalledTimes(1);
  });

  // Legacy manifests without routing metadata are never classified by employee name or description.
  // Authoritative metadata belongs in manifest.routing, which also makes new employee types discoverable.
  it.each([
    [
      "marketing-employee",
      "AI marketing employee. Supports campaign planning, drafts on-brand content."
    ],
    [
      "hr-employee",
      "AI HR employee. Guides onboarding and routes sensitive matters to your human HR team."
    ],
    [
      "finance-employee",
      "AI finance employee. Helps with reports, invoices, with approvals kept in human hands."
    ],
    ["customer-support-employee", "AI customer support employee. Troubleshoots common issues."],
    [
      "it-support-employee",
      "AI IT support employee. Handles first-line technical support and VPN issues."
    ]
  ])(
    "does not guess %s from generic English words in its description",
    async (slug, description) => {
      const plugin = {
        id: "p1",
        organizationId: "org-1",
        slug,
        displayName: slug,
        description,
        status: "ACTIVE",
        deletedAt: null,
        manifest: {}
      };
      const prisma = mockPrisma([plugin]);
      const service = new PluginService(
        prisma as never,
        {} as never,
        {} as never,
        encryption,
        {} as never,
        {} as never,
        {} as never,
        { allowDevelopmentImplementations: true } as never
      );
      await service.backfillRoutingProfiles();
      const callArg = prisma.employeeRoutingProfile.create.mock.calls[0]?.[0];
      expect(callArg?.data.employeeType).toBeNull();
      expect(callArg?.data.supportedDomains).toEqual([]);
    }
  );

  it("repairs a DEFAULTS-sourced profile that no longer matches fresh classification", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "marketing-employee",
      displayName: "Marketing Employee",
      description: "AI marketing employee. Supports campaign planning.",
      status: "ACTIVE",
      deletedAt: null,
      manifest: {}
    };
    const wrongExisting = {
      pluginInstallationId: "p1",
      employeeType: "IT_SUPPORT",
      supportedDomains: ["IT"],
      supportedIntents: [],
      routingKeywords: [],
      excludedIntents: [],
      summary: "old"
    };
    const prisma = mockPrisma([plugin], wrongExisting);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    const repaired = await service.repairRoutingProfiles();
    expect(repaired).toBe(1);
    const updateArg = prisma.employeeRoutingProfile.update.mock.calls[0]?.[0];
    expect(updateArg?.data.employeeType).toBeNull();
  });

  it("does not repair a profile whose manifest declared its own routing block", async () => {
    const plugin = {
      id: "p1",
      organizationId: "org-1",
      slug: "marketing-employee",
      displayName: "Marketing Employee",
      description: "AI marketing employee.",
      status: "ACTIVE",
      deletedAt: null,
      manifest: { routing: { employeeType: "CUSTOM_TYPE" } }
    };
    const existing = {
      pluginInstallationId: "p1",
      employeeType: "CUSTOM_TYPE",
      supportedDomains: [],
      supportedIntents: [],
      routingKeywords: [],
      excludedIntents: [],
      summary: "custom"
    };
    const prisma = mockPrisma([plugin], existing);
    const service = new PluginService(
      prisma as never,
      {} as never,
      {} as never,
      encryption,
      {} as never,
      {} as never,
      {} as never,
      { allowDevelopmentImplementations: true } as never
    );
    const repaired = await service.repairRoutingProfiles();
    expect(repaired).toBe(0);
    expect(prisma.employeeRoutingProfile.update).not.toHaveBeenCalled();
  });

  // Sprint 6.4 — Part 3: an org that installed HR before "salary" existed in the manifest must pick up
  // the new keyword the next time the API boots, without losing whatever the profile already had.
  describe("startup reconciliation (Part 3)", () => {
    function serviceWithCatalog(
      prisma: MockPrisma,
      manifestBySlug: Record<string, Record<string, unknown>>
    ) {
      const discovery = {
        discover: vi.fn().mockResolvedValue({
          plugins: Object.entries(manifestBySlug).map(([id, manifest]) => ({
            manifest: { id, ...manifest },
            create: () => ({}) as never
          })),
          errors: []
        })
      };
      return new PluginService(
        prisma as never,
        {} as never,
        {} as never,
        encryption,
        { has: () => true, register: () => {} } as never,
        discovery as never,
        {} as never,
        { allowDevelopmentImplementations: true } as never
      );
    }

    it("adds newly-introduced manifest keywords to an existing profile without dropping old ones", async () => {
      const plugin = {
        id: "p1",
        organizationId: "org-1",
        slug: "hr-employee",
        displayName: "HR Employee",
        description: "AI HR employee",
        status: "ACTIVE",
        deletedAt: null,
        manifest: { routing: { keywords: ["leave"] } } // stale install-time snapshot
      };
      // The existing row already has "leave" (from the old manifest) plus "custom-tenant-term" — standing
      // in for whatever a future tenant-customization feature might have added. Neither must be lost.
      const existing = {
        pluginInstallationId: "p1",
        routingKeywords: ["leave", "custom-tenant-term"],
        supportedDomains: [],
        capabilities: [],
        supportedIntents: [],
        exampleQueries: []
      };
      const prisma = mockPrisma([plugin], existing);
      const service = serviceWithCatalog(prisma, {
        "hr-employee": { routing: { keywords: ["leave", "salary", "payroll"] } }
      });
      await service.onModuleInit();
      expect(prisma.employeeRoutingProfile.update).toHaveBeenCalled();
      const updateArg = prisma.employeeRoutingProfile.update.mock.calls.at(-1)?.[0];
      const merged = updateArg?.data.routingKeywords as string[];
      expect(merged).toEqual(
        expect.arrayContaining(["leave", "custom-tenant-term", "salary", "payroll"])
      );
    });

    it("does not write anything when the manifest introduced nothing new (no update churn on every boot)", async () => {
      const plugin = {
        id: "p1",
        organizationId: "org-1",
        slug: "hr-employee",
        displayName: "HR Employee",
        description: "AI HR employee",
        status: "ACTIVE",
        deletedAt: null,
        manifest: { routing: { keywords: ["leave", "salary"] } }
      };
      const existing = {
        pluginInstallationId: "p1",
        routingKeywords: ["leave", "salary"],
        supportedDomains: [],
        capabilities: [],
        supportedIntents: [],
        exampleQueries: []
      };
      const prisma = mockPrisma([plugin], existing);
      const service = serviceWithCatalog(prisma, {
        "hr-employee": { routing: { keywords: ["leave", "salary"] } }
      });
      await service.onModuleInit();
      expect(prisma.employeeRoutingProfile.update).not.toHaveBeenCalled();
    });
  });
});
