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
