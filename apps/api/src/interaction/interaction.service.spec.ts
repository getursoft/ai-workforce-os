import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { AppConfig } from "../config/config.tokens";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { InteractionService } from "./interaction.service";

const config = {
  string: (_: string, fallback?: string) => fallback ?? "",
  number: (_: string, fallback?: number) => fallback ?? 0
} as unknown as AppConfig;

function baseInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: "interaction-1",
    organizationId: "org-1",
    referenceId: "KRV-842731",
    conversationId: null,
    voiceSessionId: null,
    channelConnectionId: null,
    externalUserId: null,
    phoneNumber: null,
    email: null,
    channel: "WHATSAPP",
    transport: null,
    status: "ACTIVE",
    entryAgentId: null,
    currentAgentId: null,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    completedAt: null,
    resolutionSummary: null,
    referenceCommunicatedAt: null,
    ...overrides
  };
}

describe("InteractionService.findOrCreate", () => {
  it("creates a new interaction with a generated reference id when nothing matches", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockImplementation(({ data }) => Promise.resolve(baseInteraction(data)));
    const prisma = { interaction: { findFirst, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const interaction = await service.findOrCreate({
      organizationId: "org-1",
      channel: "WHATSAPP" as never,
      channelConnectionId: "channel-1",
      externalUserId: "+14155551234"
    });

    expect(interaction.referenceId).toMatch(/^KRV-[A-Z0-9]{6}$/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("finds an existing interaction by conversationId rather than creating a new one", async () => {
    const existing = baseInteraction({ conversationId: "conversation-1" });
    const findFirst = vi.fn().mockResolvedValue(existing);
    const update = vi.fn().mockResolvedValue(existing);
    const create = vi.fn();
    const prisma = { interaction: { findFirst, update, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const interaction = await service.findOrCreate({
      organizationId: "org-1",
      channel: "WEB_CHAT" as never,
      conversationId: "conversation-1"
    });

    expect(interaction.id).toBe("interaction-1");
    expect(create).not.toHaveBeenCalled();
  });

  it("finds the most recent non-terminal interaction for the same channel identity when no conversationId is known yet", async () => {
    const existing = baseInteraction({ channelConnectionId: "channel-1", externalUserId: "+14155551234" });
    const findFirst = vi.fn().mockResolvedValue(existing);
    const update = vi.fn().mockResolvedValue(existing);
    const prisma = { interaction: { findFirst, update } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    await service.findOrCreate({
      organizationId: "org-1",
      channel: "WHATSAPP" as never,
      channelConnectionId: "channel-1",
      externalUserId: "+14155551234"
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          channelConnectionId: "channel-1",
          externalUserId: "+14155551234",
          status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] }
        })
      })
    );
  });

  it("re-links to the Receptionist's Interaction via linkedConversationId instead of creating a second one (UAT-003)", async () => {
    const existing = baseInteraction({ conversationId: "receptionist-conversation-1", referenceId: "KRV-ABC123" });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // no interaction on the brand-new specialist conversationId
      .mockResolvedValueOnce(existing); // found via linkedConversationId
    const update = vi.fn().mockResolvedValue({ ...existing, conversationId: "specialist-conversation-1" });
    const create = vi.fn();
    const prisma = { interaction: { findFirst, update, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const interaction = await service.findOrCreate({
      organizationId: "org-1",
      channel: "WEB_CHAT" as never,
      conversationId: "specialist-conversation-1",
      linkedConversationId: "receptionist-conversation-1"
    });

    expect(create).not.toHaveBeenCalled();
    expect(interaction.referenceId).toBe("KRV-ABC123");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "interaction-1" },
        data: expect.objectContaining({ conversationId: "specialist-conversation-1" })
      })
    );
  });

  it("does not touch linkedConversationId once the specialist conversation already has its own interaction", async () => {
    const existing = baseInteraction({ conversationId: "specialist-conversation-1" });
    const findFirst = vi.fn().mockResolvedValueOnce(existing);
    const update = vi.fn().mockResolvedValue(existing);
    const create = vi.fn();
    const prisma = { interaction: { findFirst, update, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    await service.findOrCreate({
      organizationId: "org-1",
      channel: "WEB_CHAT" as never,
      conversationId: "specialist-conversation-1",
      linkedConversationId: "receptionist-conversation-1"
    });

    // The direct conversationId match (step 1) wins — linkedConversationId is never even queried.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("retries with a new candidate reference id on a unique-constraint collision (STEP 2/44)", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const collision = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    const create = vi
      .fn()
      .mockRejectedValueOnce(collision)
      .mockImplementationOnce(({ data }) => Promise.resolve(baseInteraction(data)));
    const prisma = { interaction: { findFirst, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const interaction = await service.findOrCreate({ organizationId: "org-1", channel: "WEB_CHAT" as never });

    expect(create).toHaveBeenCalledTimes(2);
    expect(interaction).toBeTruthy();
  });

  it("gives up after repeated collisions rather than retrying forever", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const collision = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
    const create = vi.fn().mockRejectedValue(collision);
    const prisma = { interaction: { findFirst, create } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    await expect(service.findOrCreate({ organizationId: "org-1", channel: "WEB_CHAT" as never })).rejects.toThrow(
      "INTERACTION_REFERENCE_ID_EXHAUSTED"
    );
    expect(create).toHaveBeenCalledTimes(5);
  });
});

describe("InteractionService.complete / fail — idempotency (STEP 31)", () => {
  it("is idempotent: completing an already-terminal interaction is a harmless no-op", async () => {
    const terminal = baseInteraction({ status: "COMPLETED", completedAt: new Date() });
    const findFirst = vi.fn().mockResolvedValue(terminal);
    const update = vi.fn();
    const prisma = { interaction: { findFirst, update } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const result = await service.complete("org-1", "interaction-1");

    expect(result.alreadyTerminal).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("transitions ACTIVE to COMPLETED and stamps completedAt", async () => {
    const active = baseInteraction({ status: "ACTIVE" });
    const findFirst = vi.fn().mockResolvedValue(active);
    const update = vi.fn().mockResolvedValue(baseInteraction({ status: "COMPLETED" }));
    const prisma = { interaction: { findFirst, update } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const result = await service.complete("org-1", "interaction-1", { resolutionSummary: "Booked a trip" });

    expect(result.alreadyTerminal).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", resolutionSummary: "Booked a trip" }) })
    );
  });

  it("throws when the interaction does not exist in this organization (tenant isolation)", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { interaction: { findFirst } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);
    await expect(service.complete("org-1", "interaction-1")).rejects.toThrow("INTERACTION_NOT_FOUND");
  });
});

describe("InteractionService.claimReferenceCommunication — double-send guard (STEP 10/31)", () => {
  it("returns true exactly once — the first caller wins the atomic claim", async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const prisma = { interaction: { updateMany } } as unknown as PrismaService;
    const service = new InteractionService(prisma, config);

    const first = await service.claimReferenceCommunication("org-1", "interaction-1");
    const second = await service.claimReferenceCommunication("org-1", "interaction-1");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ referenceCommunicatedAt: null }) })
    );
  });
});
