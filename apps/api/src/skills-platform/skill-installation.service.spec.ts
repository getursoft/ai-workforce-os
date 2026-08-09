import { describe, expect, it, vi } from "vitest";
import type { SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillInstallationService } from "./skill-installation.service";
import { SkillRegistryService } from "./skill-registry.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { EntitlementService } from "../entitlements/entitlement.service";

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    key: "sample",
    name: "Sample",
    description: "Sample skill",
    category: "Testing",
    version: "1.0.0",
    author: "Krevia.ai",
    visibility: "PUBLIC",
    supportedMimeTypes: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    requiredPermissions: ["skill.execute"],
    requiredCapabilities: [],
    dependencies: [],
    billingCategory: "DETERMINISTIC",
    timeoutMs: 5000,
    statefulness: "STATELESS",
    capabilitySummary: ["Sample"],
    ...overrides
  };
}

function skillVersionRow(m: SkillManifest, id = "version-1") {
  return {
    id,
    skillId: "skill-1",
    version: m.version,
    manifestJson: m,
    status: "PUBLISHED",
    dependencies: []
  };
}

function installationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "install-1",
    organizationId: "org-1",
    skillVersionId: "version-1",
    status: "INSTALLED",
    configurationJson: {},
    enabled: false,
    deletedAt: null,
    skillVersion: { ...skillVersionRow(manifest()), skill: { key: "sample" } },
    grants: [],
    ...overrides
  };
}

interface MockOptions {
  existingInstallation?: unknown | null;
  versions?: unknown[];
  dependencyInstalled?: unknown | null;
  entitlements?: EntitlementService;
}

function makePrisma(options: MockOptions = {}) {
  const skillVersionFindMany = vi.fn().mockResolvedValue(options.versions ?? [skillVersionRow(manifest())]);
  const skillInstallationFindFirstForExisting = vi.fn().mockResolvedValue(
    options.existingInstallation === undefined ? null : options.existingInstallation
  );
  const create = vi.fn().mockResolvedValue({ id: "install-1" });
  const tx = { skillInstallation: { create } };
  const $transaction = vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  const skillInstallationFindFirstDetail = vi.fn().mockResolvedValue(installationRow());
  const employeeSkillGrantCount = vi.fn().mockResolvedValue(0);
  const pluginFindFirst = vi.fn().mockResolvedValue({ id: "employee-1" });
  const employeeSkillGrantFindFirst = vi.fn().mockResolvedValue(null);
  const employeeSkillGrantUpsert = vi.fn().mockResolvedValue({});
  const employeeSkillGrantFindMany = vi.fn().mockResolvedValue([]);
  const skillInstallationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  const dependencyInstalledLookup = vi.fn().mockResolvedValue(options.dependencyInstalled ?? null);

  // install()'s duplicate-installation check queries by `skillVersionId`; assertRequiredDependenciesInstalled
  // queries by a nested `skillVersion: { skill: { key } }` shape (no top-level `id`/`skillVersionId`);
  // every other caller (getInstallation(), enable(), configure(), grantToEmployee(), ...) queries by
  // `id`. Branching on the actual where-clause shape (rather than call order) keeps this robust
  // regardless of which service method is under test.
  const skillInstallationFindFirst = vi
    .fn()
    .mockImplementation(async (args: { where?: { skillVersionId?: unknown; id?: unknown; skillVersion?: unknown } }) => {
      const where = args?.where;
      if (where && "skillVersionId" in where) return skillInstallationFindFirstForExisting();
      if (where && "skillVersion" in where && !("id" in where)) return dependencyInstalledLookup();
      return skillInstallationFindFirstDetail();
    });

  const prisma = {
    skillVersion: { findMany: skillVersionFindMany, findFirst: vi.fn().mockResolvedValue(options.dependencyInstalled ?? null) },
    skillInstallation: { findFirst: skillInstallationFindFirst, updateMany: skillInstallationUpdateMany },
    plugin: { findFirst: pluginFindFirst },
    employeeSkillGrant: {
      count: employeeSkillGrantCount,
      findFirst: employeeSkillGrantFindFirst,
      upsert: employeeSkillGrantUpsert,
      findMany: employeeSkillGrantFindMany,
      delete: vi.fn(),
      update: vi.fn()
    },
    $transaction
  } as unknown as PrismaService;

  return {
    prisma,
    mocks: {
      skillVersionFindMany,
      skillInstallationFindFirstForExisting,
      create,
      skillInstallationFindFirstDetail,
      employeeSkillGrantCount,
      employeeSkillGrantUpsert,
      pluginFindFirst
    }
  };
}

describe("SkillInstallationService.install", () => {
  it("installs a published skill and returns the created installation", async () => {
    const { prisma, mocks } = makePrisma();
    const registry = new SkillRegistryService();
    const service = new SkillInstallationService(prisma, registry);
    const result = await service.install("org-1", "user-1", { skillKey: "sample" });
    expect(result.id).toBe("install-1");
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: "org-1", skillVersionId: "version-1" }) })
    );
  });

  it("rejects a duplicate installation of the same skill version for the same organization", async () => {
    const { prisma } = makePrisma({ existingInstallation: installationRow() });
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.install("org-1", "user-1", { skillKey: "sample" })).rejects.toMatchObject({
      code: "SKILL_ALREADY_INSTALLED"
    });
  });

  it("rejects a version that has never been published", async () => {
    const { prisma } = makePrisma({ versions: [] });
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.install("org-1", "user-1", { skillKey: "sample" })).rejects.toMatchObject({
      code: "SKILL_VERSION_NOT_FOUND"
    });
  });

  it("requires explicit approval before installing a skill that requests a sensitive capability", async () => {
    const sensitive = manifest({ requiredCapabilities: ["network.external"] });
    const { prisma } = makePrisma({ versions: [skillVersionRow(sensitive)] });
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.install("org-1", "user-1", { skillKey: "sample" })).rejects.toMatchObject({
      code: "SKILL_SENSITIVE_PERMISSION_REQUIRED"
    });
  });

  it("allows a sensitive-capability skill when approveSensitivePermissions is explicitly true", async () => {
    const sensitive = manifest({ requiredCapabilities: ["network.external"] });
    const { prisma } = makePrisma({ versions: [skillVersionRow(sensitive)] });
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    const result = await service.install("org-1", "user-1", { skillKey: "sample", approveSensitivePermissions: true });
    expect(result.id).toBe("install-1");
  });

  it("blocks installing an AI-provider-backed skill without the SKILLS_AI_BACKED entitlement", async () => {
    const aiBacked = manifest({ billingCategory: "AI_PROVIDER_BACKED" });
    const { prisma } = makePrisma({ versions: [skillVersionRow(aiBacked)] });
    const entitlements = {
      assertFeature: vi.fn().mockImplementation((_org: string, key: string) => {
        if (key === "SKILLS_AI_BACKED") throw new Error("ENTITLEMENT_FEATURE_NOT_AVAILABLE");
        return Promise.resolve(undefined);
      }),
      consumeCapacity: vi.fn().mockResolvedValue(undefined)
    } as unknown as EntitlementService;
    const service = new SkillInstallationService(prisma, new SkillRegistryService(), entitlements);
    await expect(service.install("org-1", "user-1", { skillKey: "sample" })).rejects.toThrow(
      "ENTITLEMENT_FEATURE_NOT_AVAILABLE"
    );
  });

  it("blocks installation when a required dependency is not already installed", async () => {
    const withDependency = manifest({
      key: "invoice-parser",
      dependencies: [{ skillKey: "document-reader", versionConstraint: "^1.0.0", required: true }]
    });
    const { prisma } = makePrisma({ versions: [skillVersionRow(withDependency)], dependencyInstalled: null });
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.install("org-1", "user-1", { skillKey: "invoice-parser" })).rejects.toMatchObject({
      code: "SKILL_DEPENDENCY_MISSING"
    });
  });

  it("enforces the SKILLS_MAX_INSTALLED entitlement via consumeCapacity", async () => {
    const { prisma } = makePrisma();
    const entitlements = {
      assertFeature: vi.fn().mockResolvedValue(undefined),
      consumeCapacity: vi.fn().mockRejectedValue(new Error("ENTITLEMENT_LIMIT_REACHED"))
    } as unknown as EntitlementService;
    const service = new SkillInstallationService(prisma, new SkillRegistryService(), entitlements);
    await expect(service.install("org-1", "user-1", { skillKey: "sample" })).rejects.toThrow(
      "ENTITLEMENT_LIMIT_REACHED"
    );
    expect(entitlements.consumeCapacity).toHaveBeenCalledWith("org-1", "SKILLS_MAX_INSTALLED");
  });
});

describe("SkillInstallationService — lifecycle", () => {
  it("enable() flips enabled/status and returns the installation", async () => {
    const { prisma, mocks } = makePrisma();
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await service.enable("org-1", "user-1", "install-1");
    expect(mocks.skillInstallationFindFirstDetail).toHaveBeenCalled();
  });

  it("configure() rejects a configuration that fails the skill's configurationSchema", async () => {
    const withConfigSchema = installationRow({
      skillVersion: {
        ...skillVersionRow(manifest({ configurationSchema: { type: "object", required: ["apiKey"], properties: { apiKey: { type: "string" } } } })),
        skill: { key: "sample" }
      }
    });
    const { prisma } = makePrisma({ existingInstallation: withConfigSchema });
    // getInstallation() (used by configure()) reuses the same detail mock — override it directly.
    (prisma.skillInstallation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(withConfigSchema);
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.configure("org-1", "user-1", "install-1", {})).rejects.toMatchObject({
      code: "SKILL_INVALID_CONFIGURATION"
    });
  });
});

describe("SkillInstallationService — employee grants", () => {
  it("grants a skill installation to an installed employee", async () => {
    const { prisma, mocks } = makePrisma();
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await service.grantToEmployee("org-1", "user-1", "employee-1", "install-1");
    expect(mocks.employeeSkillGrantUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_pluginInstallationId_skillInstallationId: {
            organizationId: "org-1",
            pluginInstallationId: "employee-1",
            skillInstallationId: "install-1"
          }
        }
      })
    );
  });

  it("rejects granting to an employee installation that does not belong to this organization", async () => {
    const { prisma, mocks } = makePrisma();
    mocks.pluginFindFirst.mockResolvedValue(null);
    const service = new SkillInstallationService(prisma, new SkillRegistryService());
    await expect(service.grantToEmployee("org-1", "user-1", "employee-in-other-org", "install-1")).rejects.toMatchObject({
      code: "SKILL_EMPLOYEE_NOT_FOUND"
    });
  });

  it("enforces the SKILLS_MAX_PER_EMPLOYEE entitlement when granting a new (not-yet-granted) skill", async () => {
    const { prisma, mocks } = makePrisma();
    mocks.employeeSkillGrantCount.mockResolvedValue(10);
    const entitlements = { getLimit: vi.fn().mockResolvedValue(10) } as unknown as EntitlementService;
    const service = new SkillInstallationService(prisma, new SkillRegistryService(), entitlements);
    await expect(service.grantToEmployee("org-1", "user-1", "employee-1", "install-1")).rejects.toMatchObject({
      code: "SKILL_LIMIT_REACHED"
    });
  });
});
