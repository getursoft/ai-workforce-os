import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { BillingService } from "./billing.service";

/** Real UAT bug: `byCapability` groups raw executions by `modelProvider` first, then maps each raw group
 *  down to one of only two coarse capability buckets — but never merged groups that collapsed onto the
 *  SAME bucket, so the UI showed the same "Chat Generation" label three times with three different
 *  percentages instead of one merged row. */
describe("BillingService.byCapability", () => {
  it("merges multiple modelProvider groups that map to the same capability into one row, never repeating the same display name", async () => {
    const prisma = {
      agentExecution: {
        groupBy: vi.fn().mockResolvedValue([
          { modelProvider: "OPENAI_COMPATIBLE", _sum: { totalTokens: 24000 } },
          { modelProvider: "openai-compatible", _sum: { totalTokens: 450 } },
          { modelProvider: "AZURE_OPENAI", _sum: { totalTokens: 250 } },
          { modelProvider: "DETERMINISTIC", _sum: { totalTokens: 800 } }
        ])
      }
    } as unknown as PrismaService;
    const service = new BillingService(prisma);

    const result = await service.byCapability("org-1", new Date("2026-07-01"), new Date("2026-07-31"));

    const labels = result.map((r) => r.displayName);
    expect(new Set(labels).size).toBe(labels.length);
    expect(result).toHaveLength(2);
    const chatGeneration = result.find((r) => r.displayName === "Chat Generation");
    expect(chatGeneration).toBeDefined();
    // 24000 + 450 + 250 = 24700 tokens merged into the single Chat Generation row.
    expect(chatGeneration?.creditsConsumed).toBe(Math.ceil((24700 * 4) / 1000));
    const toolExecution = result.find((r) => r.displayName === "Tool Execution");
    expect(toolExecution?.creditsConsumed).toBe(Math.ceil((800 * 4) / 1000));
    const totalShare = result.reduce((sum, r) => sum + r.sharePercentage, 0);
    expect(totalShare).toBeCloseTo(100, 0);
  });
});

describe("BillingService.employeesOverview", () => {
  it("merges plugin status, usage, and lead counts per employee, scoped to the requesting organization", async () => {
    const findManyPlugin = vi.fn().mockResolvedValue([
      { id: "plugin-1", displayName: "Sales", slug: "sales-employee", status: "ACTIVE" },
      { id: "plugin-2", displayName: "HR", slug: "hr-employee", status: "DISABLED" }
    ]);
    const groupByExecution = vi.fn().mockResolvedValue([
      { pluginInstallationId: "plugin-1", _sum: { totalTokens: 5000 }, _count: { id: 12 }, _max: { createdAt: new Date("2026-09-01T00:00:00.000Z") } }
    ]);
    const groupByLead = vi.fn().mockResolvedValue([{ agentId: "plugin-1", _count: { id: 3 } }]);
    const prisma = {
      plugin: { findMany: findManyPlugin },
      agentExecution: { groupBy: groupByExecution },
      lead: { groupBy: groupByLead }
    } as unknown as PrismaService;
    const service = new BillingService(prisma);

    const result = await service.employeesOverview("org-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(findManyPlugin).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1" }) }));
    expect(result).toHaveLength(2);
    const sales = result.find((r) => r.pluginInstallationId === "plugin-1")!;
    expect(sales.active).toBe(true);
    expect(sales.conversations).toBe(12);
    expect(sales.leadsGenerated).toBe(3);
    expect(sales.creditsConsumed).toBe(Math.ceil((5000 * 4) / 1000));
    const hr = result.find((r) => r.pluginInstallationId === "plugin-2")!;
    expect(hr.active).toBe(false);
    expect(hr.conversations).toBe(0);
    expect(hr.leadsGenerated).toBe(0);
  });

  it("returns an empty list when the organization has no plugins, without querying usage/leads", async () => {
    const findManyPlugin = vi.fn().mockResolvedValue([]);
    const groupByExecution = vi.fn();
    const prisma = {
      plugin: { findMany: findManyPlugin },
      agentExecution: { groupBy: groupByExecution },
      lead: { groupBy: vi.fn() }
    } as unknown as PrismaService;
    const service = new BillingService(prisma);

    const result = await service.employeesOverview("org-empty", new Date(), new Date());

    expect(result).toEqual([]);
    expect(groupByExecution).not.toHaveBeenCalled();
  });
});

describe("BillingService.employeeDetail", () => {
  it("returns null when the plugin does not belong to the requesting organization (tenant isolation)", async () => {
    const findFirstPlugin = vi.fn().mockResolvedValue(null);
    const prisma = { plugin: { findFirst: findFirstPlugin } } as unknown as PrismaService;
    const service = new BillingService(prisma);

    const result = await service.employeeDetail("org-1", "plugin-owned-by-another-org");

    expect(result).toBeNull();
    expect(findFirstPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1", id: "plugin-owned-by-another-org" }) })
    );
  });

  it("computes today/week/month usage windows and a recent-activity feed for an in-tenant employee", async () => {
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({ id: "plugin-1", displayName: "Sales", slug: "sales-employee", status: "ACTIVE" })
      },
      agentExecution: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { totalTokens: 1000 }, _count: { id: 2 } }),
        count: vi.fn().mockResolvedValue(9),
        findMany: vi.fn().mockResolvedValue([
          { id: "exec-1", status: "COMPLETED", createdAt: new Date("2026-09-01T00:00:00.000Z"), totalTokens: 500 }
        ])
      },
      lead: { count: vi.fn().mockResolvedValue(4) }
    } as unknown as PrismaService;
    const service = new BillingService(prisma);

    const result = await service.employeeDetail("org-1", "plugin-1");

    expect(result?.usageToday.creditsConsumed).toBe(Math.ceil((1000 * 4) / 1000));
    expect(result?.usageToday.executions).toBe(2);
    expect(result?.leadsGenerated).toBe(4);
    expect(result?.conversations).toBe(9);
    expect(result?.recentActivity).toHaveLength(1);
    expect(result?.recentActivity[0]?.creditsConsumed).toBe(Math.ceil((500 * 4) / 1000));
  });
});
