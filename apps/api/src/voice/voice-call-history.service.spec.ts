import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config/config.tokens";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { maskCallerId, VoiceCallHistoryService } from "./voice-call-history.service";

function configWith(overrides: Record<string, boolean | number> = {}): AppConfig {
  return {
    boolean: (name: string, fallback?: boolean) => (name in overrides ? (overrides[name] as boolean) : (fallback ?? false)),
    number: (name: string, fallback?: number) => (name in overrides ? (overrides[name] as number) : (fallback ?? 0))
  } as unknown as AppConfig;
}
const defaultConfig = configWith();

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    organizationId: "org-1",
    channelConnectionId: "channel-1",
    receptionistConversationId: "conversation-1",
    activeHandoffId: null,
    provider: "TWILIO",
    providerCallId: "CA123",
    providerStreamId: "MZ123",
    externalCallerId: "+14155551234",
    transport: "PSTN",
    direction: "INBOUND",
    status: "ENDED",
    startedAt: new Date("2026-09-01T10:00:00Z"),
    answeredAt: new Date("2026-09-01T10:00:02Z"),
    endedAt: new Date("2026-09-01T10:01:02Z"),
    lastActivityAt: new Date("2026-09-01T10:01:02Z"),
    terminationReason: "CALLER_HANGUP",
    speechEndToAckMs: 500,
    routingMs: 200,
    specialistFirstResponseMs: 900,
    totalTurnMs: 1400,
    ...overrides
  };
}

describe("maskCallerId", () => {
  it("masks all but the last 4 characters by default", () => {
    expect(maskCallerId("+14155551234")).toBe("********1234");
  });
  it("passes through null unchanged", () => {
    expect(maskCallerId(null)).toBeNull();
  });
  it("returns the caller id unchanged when mask is explicitly false", () => {
    expect(maskCallerId("+14155551234", false)).toBe("+14155551234");
  });
});

describe("VoiceCallHistoryService.list", () => {
  it("scopes the query to the caller's organization and applies filters", async () => {
    const findMany = vi.fn().mockResolvedValue([baseSession()]);
    const count = vi.fn().mockResolvedValue(1);
    const prisma = {
      voiceSession: { findMany, count },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);

    const result = await service.list("org-1", { page: 1, pageSize: 20, status: "ENDED" as never });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1", status: "ENDED" }) })
    );
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ id: "session-1", callerId: "********1234", durationSeconds: 60 });
    expect(result.items[0]).not.toHaveProperty("externalCallerId");
  });

  it("resolves an agentId filter into a receptionistConversationId IN (...) clause scoped to the org", async () => {
    const conversationFindMany = vi.fn().mockResolvedValue([{ id: "conversation-1" }, { id: "conversation-2" }]);
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = {
      conversation: { findMany: conversationFindMany },
      voiceSession: { findMany, count },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);

    await service.list("org-1", { page: 1, pageSize: 20, agentId: "agent-1" });

    expect(conversationFindMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", pluginInstallationId: "agent-1" },
      select: { id: true }
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ receptionistConversationId: { in: ["conversation-1", "conversation-2"] } })
      })
    );
  });

  it("returns the raw caller id when VOICE_MASK_CALLER_ID is explicitly disabled", async () => {
    const findMany = vi.fn().mockResolvedValue([baseSession()]);
    const count = vi.fn().mockResolvedValue(1);
    const prisma = {
      voiceSession: { findMany, count },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, configWith({ VOICE_MASK_CALLER_ID: false }));

    const result = await service.list("org-1", { page: 1, pageSize: 20 });

    expect(result.items[0]).toMatchObject({ callerId: "+14155551234" });
  });
});

describe("VoiceCallHistoryService.get", () => {
  it("throws NotFoundException when the session does not belong to the caller's organization", async () => {
    const prisma = { voiceSession: { findFirst: vi.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);
    await expect(service.get("org-1", "session-1")).rejects.toMatchObject({ status: 404 });
  });

  it("includes handoffs scoped to the same organization and conversation", async () => {
    const findFirst = vi.fn().mockResolvedValue(baseSession());
    const handoffFindMany = vi.fn().mockResolvedValue([{ id: "handoff-1", status: "COMPLETED" }]);
    const prisma = {
      voiceSession: { findFirst },
      receptionistHandoff: { findMany: handoffFindMany }
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);

    const result = await service.get("org-1", "session-1");

    expect(handoffFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1", conversationId: "conversation-1" } })
    );
    expect(result.handoffs).toEqual([{ id: "handoff-1", status: "COMPLETED" }]);
  });
});

describe("VoiceCallHistoryService.transcript", () => {
  it("404s before ever querying segments if the session isn't visible to this organization", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const segmentFindMany = vi.fn();
    const prisma = {
      voiceSession: { findFirst },
      voiceTranscriptSegment: { findMany: segmentFindMany, count: vi.fn() }
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);

    await expect(service.transcript("org-1", "session-1", { page: 1, pageSize: 20 })).rejects.toMatchObject({ status: 404 });
    expect(segmentFindMany).not.toHaveBeenCalled();
  });

  it("returns ordered, paginated segments scoped to the organization and session", async () => {
    const findFirst = vi.fn().mockResolvedValue(baseSession());
    const handoffFindMany = vi.fn().mockResolvedValue([]);
    const segmentFindMany = vi.fn().mockResolvedValue([{ id: "seg-1", sequenceNumber: 1, text: "hello" }]);
    const segmentCount = vi.fn().mockResolvedValue(1);
    const prisma = {
      voiceSession: { findFirst },
      receptionistHandoff: { findMany: handoffFindMany },
      voiceTranscriptSegment: { findMany: segmentFindMany, count: segmentCount },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops))
    } as unknown as PrismaService;
    const service = new VoiceCallHistoryService(prisma, defaultConfig);

    const result = await service.transcript("org-1", "session-1", { page: 1, pageSize: 20 });

    expect(segmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", voiceSessionId: "session-1" },
        orderBy: { sequenceNumber: "asc" }
      })
    );
    expect(result.items).toEqual([{ id: "seg-1", sequenceNumber: 1, text: "hello" }]);
  });
});
