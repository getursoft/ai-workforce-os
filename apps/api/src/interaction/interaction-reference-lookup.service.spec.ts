import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config/config.tokens";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { InteractionMetricsService } from "./interaction-metrics.service";
import { InteractionReferenceLookupService } from "./interaction-reference-lookup.service";

const config = { string: (_: string, fallback?: string) => fallback ?? "" } as unknown as AppConfig;

function baseInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-1",
    referenceId: "KRV-842731",
    status: "COMPLETED",
    channel: "WHATSAPP",
    startedAt: new Date(),
    completedAt: new Date(),
    entryAgentId: "agent-1",
    currentAgentId: "agent-2",
    conversationId: "conversation-1",
    resolutionSummary: "Booked a Dubai trip",
    ...overrides
  };
}

describe("InteractionReferenceLookupService (Sprint 7.12 STEP 23/24/25)", () => {
  it("normalizes user-supplied reference text before looking it up (tenant-scoped)", async () => {
    const findFirst = vi.fn().mockResolvedValue(baseInteraction());
    const summaryFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      interaction: { findFirst },
      conversationSummary: { findFirst: summaryFindFirst }
    } as unknown as PrismaService;
    const service = new InteractionReferenceLookupService(prisma, config, new InteractionMetricsService());

    const result = await service.lookup("org-1", "krv 842731");

    expect(findFirst).toHaveBeenCalledWith({ where: { organizationId: "org-1", referenceId: "KRV-842731" } });
    expect(result?.referenceId).toBe("KRV-842731");
  });

  it("returns null and increments a not-found metric for an unknown reference", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { interaction: { findFirst } } as unknown as PrismaService;
    const metrics = new InteractionMetricsService();
    const service = new InteractionReferenceLookupService(prisma, config, metrics);

    const result = await service.lookup("org-1", "KRV-000000");

    expect(result).toBeNull();
    expect(metrics.snapshot().counters.reference_lookup_not_found_total).toBe(1);
  });

  it("never returns another organization's interaction for the same reference id (tenant isolation)", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { interaction: { findFirst } } as unknown as PrismaService;
    const service = new InteractionReferenceLookupService(prisma, config, new InteractionMetricsService());

    await service.lookup("org-attacker", "KRV-842731");

    expect(findFirst).toHaveBeenCalledWith({ where: { organizationId: "org-attacker", referenceId: "KRV-842731" } });
  });

  it("prefers the existing ConversationSummary over the interaction's own resolutionSummary (STEP 25 — no raw transcript replay)", async () => {
    const findFirst = vi.fn().mockResolvedValue(baseInteraction());
    const summaryFindFirst = vi.fn().mockResolvedValue({ summary: "Rich conversation summary from existing infra" });
    const prisma = {
      interaction: { findFirst },
      conversationSummary: { findFirst: summaryFindFirst }
    } as unknown as PrismaService;
    const service = new InteractionReferenceLookupService(prisma, config, new InteractionMetricsService());

    const result = await service.lookup("org-1", "KRV-842731");

    expect(result?.summary).toBe("Rich conversation summary from existing infra");
  });

  it("falls back to the interaction's resolutionSummary when no ConversationSummary exists", async () => {
    const findFirst = vi.fn().mockResolvedValue(baseInteraction());
    const summaryFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      interaction: { findFirst },
      conversationSummary: { findFirst: summaryFindFirst }
    } as unknown as PrismaService;
    const service = new InteractionReferenceLookupService(prisma, config, new InteractionMetricsService());

    const result = await service.lookup("org-1", "KRV-842731");

    expect(result?.summary).toBe("Booked a Dubai trip");
  });
});
