import { describe, expect, it, vi } from "vitest";
import type { SkillAdapter, SkillExecutionResult, SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillsRuntimeService } from "./skill-runtime.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillError } from "./skill-error";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { ObjectStorageService } from "../storage/object-storage.types";
import type { EntitlementService } from "../entitlements/entitlement.service";

const MANIFEST: SkillManifest = {
  key: "echo",
  name: "Echo",
  description: "Echoes input back",
  category: "Testing",
  version: "1.0.0",
  author: "Krevia.ai",
  visibility: "PUBLIC",
  supportedMimeTypes: [],
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: { message: { type: "string" } }
  },
  outputSchema: { type: "object", required: ["echo"], properties: { echo: { type: "string" } } },
  requiredPermissions: ["skill.execute"],
  requiredCapabilities: [],
  dependencies: [],
  billingCategory: "DETERMINISTIC",
  timeoutMs: 200,
  retryPolicy: { maxRetries: 2, backoffMs: 1 },
  statefulness: "STATELESS",
  capabilitySummary: ["Echo"]
};

function makeAdapter(overrides: Partial<SkillAdapter> = {}): SkillAdapter {
  return {
    manifest: MANIFEST,
    validate: async () => undefined,
    execute: async (input) => ({ data: { echo: (input as { message: string }).message } }) as SkillExecutionResult,
    health: async () => ({ status: "HEALTHY", checks: [], checkedAt: new Date().toISOString() }),
    ...overrides
  };
}

function makeRegistry(adapter: SkillAdapter): SkillRegistryService {
  const registry = new SkillRegistryService();
  registry.register(adapter);
  return registry;
}

interface MockPrismaOptions {
  installation?: { id: string; configurationJson: unknown; enabled: boolean; status: string } | null;
  grant?: { id: string } | null;
  existingRun?: unknown | null;
  monthlyCount?: number;
}

function makePrisma(options: MockPrismaOptions = {}) {
  const skillRunCreate = vi.fn().mockResolvedValue({ id: "run-1" });
  const skillRunUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const skillInstallationFindFirst = vi.fn().mockResolvedValue(
    options.installation === undefined
      ? { id: "install-1", configurationJson: {}, enabled: true, status: "ENABLED" }
      : options.installation
  );
  const employeeSkillGrantFindFirst = vi.fn().mockResolvedValue(options.grant === undefined ? { id: "grant-1" } : options.grant);
  const skillRunFindFirst = vi.fn().mockResolvedValue(options.existingRun ?? null);
  const skillRunCount = vi.fn().mockResolvedValue(options.monthlyCount ?? 0);
  const usageEventCreate = vi.fn().mockResolvedValue({});
  const organizationFindUnique = vi.fn().mockResolvedValue({ settings: { locale: "en", timezone: "UTC" } });

  const prisma = {
    skillRun: {
      create: skillRunCreate,
      updateMany: skillRunUpdateMany,
      findFirst: skillRunFindFirst,
      count: skillRunCount
    },
    skillInstallation: { findFirst: skillInstallationFindFirst },
    employeeSkillGrant: { findFirst: employeeSkillGrantFindFirst },
    usageEvent: { create: usageEventCreate },
    organization: { findUnique: organizationFindUnique }
  } as unknown as PrismaService;

  return {
    prisma,
    mocks: {
      skillRunCreate,
      skillRunUpdateMany,
      skillInstallationFindFirst,
      employeeSkillGrantFindFirst,
      skillRunFindFirst,
      skillRunCount,
      usageEventCreate
    }
  };
}

const objectStorage = {} as ObjectStorageService;

function makeEntitlements(limit: number): EntitlementService {
  return { getLimit: vi.fn().mockResolvedValue(limit) } as unknown as EntitlementService;
}

describe("SkillsRuntimeService.execute — security and lifecycle", () => {
  it("executes a deterministic skill end to end and persists a COMPLETED SkillRun with usage/credits", async () => {
    const { prisma, mocks } = makePrisma();
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    const result = await service.execute({
      skillKey: "echo",
      organizationId: "org-1",
      input: { message: "hello" }
    });
    expect(result.data).toEqual({ echo: "hello" });
    expect(result.status).toBe("COMPLETED");
    expect(mocks.skillRunUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", organizationId: "org-1" },
        data: expect.objectContaining({ status: "COMPLETED" })
      })
    );
  });

  it("scopes the installation lookup by organizationId (tenant isolation at the query layer)", async () => {
    const { prisma, mocks } = makePrisma();
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    await service.execute({ skillKey: "echo", organizationId: "org-42", input: { message: "hi" } });
    const call = mocks.skillInstallationFindFirst.mock.calls[0][0];
    expect(call.where.organizationId).toBe("org-42");
  });

  it("throws SKILL_NOT_INSTALLED when the organization has no installation of this skill", async () => {
    const { prisma } = makePrisma({ installation: null });
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } })
    ).rejects.toMatchObject({ code: "SKILL_NOT_INSTALLED" });
  });

  it("throws SKILL_DISABLED when the installation exists but is disabled", async () => {
    const { prisma } = makePrisma({ installation: { id: "i1", configurationJson: {}, enabled: false, status: "DISABLED" } });
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } })
    ).rejects.toMatchObject({ code: "SKILL_DISABLED" });
  });

  it("throws SKILL_EMPLOYEE_GRANT_DENIED when a pluginInstallationId is supplied without a grant", async () => {
    const { prisma } = makePrisma({ grant: null });
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    await expect(
      service.execute({
        skillKey: "echo",
        organizationId: "org-1",
        pluginInstallationId: "employee-1",
        input: { message: "hi" }
      })
    ).rejects.toMatchObject({ code: "SKILL_EMPLOYEE_GRANT_DENIED" });
  });

  it("succeeds for a granted employee installation", async () => {
    const { prisma } = makePrisma({ grant: { id: "grant-1" } });
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    const result = await service.execute({
      skillKey: "echo",
      organizationId: "org-1",
      pluginInstallationId: "employee-1",
      input: { message: "hi" }
    });
    expect(result.status).toBe("COMPLETED");
  });

  it("rejects input that fails the skill's declared JSON schema", async () => {
    const { prisma, mocks } = makePrisma();
    const service = new SkillsRuntimeService(prisma, makeRegistry(makeAdapter()), objectStorage);
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { wrongField: 1 } })
    ).rejects.toMatchObject({ code: "SKILL_INPUT_INVALID" });
    expect(mocks.skillRunUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("rejects output that fails the skill's declared output schema", async () => {
    const { prisma } = makePrisma();
    const badAdapter = makeAdapter({ execute: async () => ({ data: { wrongField: true } }) as never });
    const service = new SkillsRuntimeService(prisma, makeRegistry(badAdapter), objectStorage);
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } })
    ).rejects.toMatchObject({ code: "SKILL_OUTPUT_INVALID" });
  });

  it("times out when the adapter exceeds the manifest's timeoutMs", async () => {
    const { prisma } = makePrisma();
    const hangingAdapter = makeAdapter({
      execute: () => new Promise(() => {
        /* never resolves */
      }) as never
    });
    const service = new SkillsRuntimeService(prisma, makeRegistry(hangingAdapter), objectStorage);
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } })
    ).rejects.toMatchObject({ code: "SKILL_TIMEOUT" });
  }, 2000);

  it("retries a transient failure up to the manifest's retryPolicy and succeeds on a later attempt", async () => {
    const { prisma } = makePrisma();
    let attempts = 0;
    const flakyAdapter = makeAdapter({
      execute: async (input) => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return { data: { echo: (input as { message: string }).message } };
      }
    });
    const service = new SkillsRuntimeService(prisma, makeRegistry(flakyAdapter), objectStorage);
    const result = await service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } });
    expect(result.status).toBe("COMPLETED");
    expect(attempts).toBe(2);
  });

  it("replays a completed execution by idempotency key instead of re-running the adapter", async () => {
    let executions = 0;
    const adapter = makeAdapter({
      execute: async (input) => {
        executions += 1;
        return { data: { echo: (input as { message: string }).message } };
      }
    });
    const { prisma } = makePrisma({
      existingRun: {
        id: "run-existing",
        skillKey: "echo",
        skillVersion: "1.0.0",
        status: "COMPLETED",
        outputSummaryJson: { value: { echo: "cached" } },
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        creditsConsumed: 1,
        durationMs: 5,
        retryCount: 0
      }
    });
    const service = new SkillsRuntimeService(prisma, makeRegistry(adapter), objectStorage);
    const result = await service.execute({
      skillKey: "echo",
      organizationId: "org-1",
      input: { message: "hi" },
      idempotencyKey: "fixed-key"
    });
    expect(result.status).toBe("REPLAY");
    expect(result.data).toEqual({ echo: "cached" });
    expect(executions).toBe(0);
  });

  it("throws SKILL_LIMIT_REACHED once the organization's monthly execution entitlement is exhausted", async () => {
    const { prisma } = makePrisma({ monthlyCount: 5 });
    const service = new SkillsRuntimeService(
      prisma,
      makeRegistry(makeAdapter()),
      objectStorage,
      undefined,
      undefined,
      undefined,
      makeEntitlements(5)
    );
    await expect(
      service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } })
    ).rejects.toMatchObject({ code: "SKILL_LIMIT_REACHED" });
  });

  it("allows execution when usage is below the monthly execution entitlement", async () => {
    const { prisma } = makePrisma({ monthlyCount: 1 });
    const service = new SkillsRuntimeService(
      prisma,
      makeRegistry(makeAdapter()),
      objectStorage,
      undefined,
      undefined,
      undefined,
      makeEntitlements(5)
    );
    const result = await service.execute({ skillKey: "echo", organizationId: "org-1", input: { message: "hi" } });
    expect(result.status).toBe("COMPLETED");
  });

  it("throws SKILL_VERSION_NOT_FOUND for a skill key that was never registered", async () => {
    const { prisma } = makePrisma();
    const service = new SkillsRuntimeService(prisma, new SkillRegistryService(), objectStorage);
    await expect(
      service.execute({ skillKey: "does-not-exist", organizationId: "org-1", input: {} })
    ).rejects.toMatchObject({ code: "SKILL_VERSION_NOT_FOUND" });
  });
});

describe("SkillsRuntimeService security helpers used elsewhere", () => {
  it("SkillError carries a stable, safe code distinct from raw error internals", () => {
    const error = new SkillError("SKILL_ENTITLEMENT_DENIED", "denied");
    expect(error.code).toBe("SKILL_ENTITLEMENT_DENIED");
    expect(error.message).toBe("denied");
  });
});
