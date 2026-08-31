import { describe, expect, it, vi } from "vitest";
import { VoiceReceptionistTurnService, VoiceSessionService } from "./voice-channel.adapter";

function service(enabled = true) {
  const prisma = {
    channelConnection: { findFirst: vi.fn().mockResolvedValue({ id: "channel-1" }) },
    conversation: { findFirst: vi.fn().mockResolvedValue({ id: "conversation-1" }) },
    voiceSession: {
      create: vi.fn().mockResolvedValue({ id: "voice-1", status: "ACTIVE" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({
        id: "voice-1",
        organizationId: "tenant-a",
        channelConnectionId: "channel-1",
        receptionistConversationId: "conversation-1",
        provider: "provider-neutral-test",
        providerCallId: "call-1",
        status: "ACTIVE"
      })
    },
    receptionistHandoff: { findFirst: vi.fn().mockResolvedValue({ id: "handoff-1" }) }
  };
  return {
    prisma,
    sessions: new VoiceSessionService(
      prisma as never,
      { boolean: vi.fn().mockReturnValue(enabled) } as never
    )
  };
}

const startInput = {
  organizationId: "tenant-a",
  channelConnectionId: "channel-1",
  receptionistConversationId: "conversation-1",
  provider: "provider-neutral-test",
  providerCallId: "call-1"
};

describe("VoiceSessionService", () => {
  it("keeps voice delivery disabled behind the global feature flag", async () => {
    const { sessions, prisma } = service(false);
    await expect(sessions.start(startInput)).rejects.toThrow("RECEPTIONIST_VOICE_DISABLED");
    expect(prisma.voiceSession.create).not.toHaveBeenCalled();
  });

  it("starts a provider-neutral session only after tenant-scoped channel and conversation checks", async () => {
    const { sessions, prisma } = service();
    await sessions.start(startInput);
    expect(prisma.channelConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "channel-1", organizationId: "tenant-a" })
      })
    );
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "conversation-1", organizationId: "tenant-a" })
      })
    );
    expect(prisma.voiceSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: "provider-neutral-test", status: "ACTIVE" })
      })
    );
  });

  it("rejects a cross-scope voice conversation", async () => {
    const { sessions, prisma } = service();
    prisma.conversation.findFirst.mockResolvedValue(null);
    await expect(sessions.start(startInput)).rejects.toThrow("VOICE_SESSION_SCOPE_INVALID");
    expect(prisma.voiceSession.create).not.toHaveBeenCalled();
  });

  it("attaches only a handoff found in the same tenant", async () => {
    const { sessions, prisma } = service();
    await sessions.attachHandoff("tenant-a", "voice-1", "handoff-1");
    expect(prisma.receptionistHandoff.findFirst).toHaveBeenCalledWith({
      where: { id: "handoff-1", organizationId: "tenant-a" },
      select: { id: true }
    });
    expect(prisma.voiceSession.updateMany).toHaveBeenCalledWith({
      where: { id: "voice-1", organizationId: "tenant-a", status: "ACTIVE" },
      data: { activeHandoffId: "handoff-1" }
    });
  });

  it("ends the correlated session without importing a provider SDK", async () => {
    const { sessions, prisma } = service();
    await sessions.end("tenant-a", "voice-1");
    expect(prisma.voiceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "voice-1", organizationId: "tenant-a" }),
        data: expect.objectContaining({ status: "ENDED" })
      })
    );
  });

  it("records the voice latency budget using provider-neutral turn metrics", async () => {
    const { sessions, prisma } = service();
    await sessions.recordTurnMetrics("tenant-a", "voice-1", {
      speechEndToAckMs: 180,
      routingMs: 42,
      specialistFirstResponseMs: 760,
      totalTurnMs: 940
    });
    expect(prisma.voiceSession.updateMany).toHaveBeenCalledWith({
      where: { id: "voice-1", organizationId: "tenant-a", status: "ACTIVE" },
      data: {
        speechEndToAckMs: 180,
        routingMs: 42,
        specialistFirstResponseMs: 760,
        totalTurnMs: 940
      }
    });
  });
});

describe("VoiceReceptionistTurnService", () => {
  it("routes a final transcript through AgentService and attaches the resulting handoff", async () => {
    const { sessions, prisma } = service();
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      pluginInstallationId: "receptionist-1",
      pluginInstallation: {
        status: "ACTIVE",
        manifest: { capabilities: ["workforce.intake"] }
      }
    });
    const agents = {
      execute: vi.fn().mockResolvedValue({
        conversationId: "conversation-1",
        response: "Travel Employee: When would you like to travel?",
        receptionist: { handoff: { id: "handoff-1" } }
      })
    };
    const turns = new VoiceReceptionistTurnService(prisma as never, sessions, agents as never);
    const outcome = await turns.handleTranscript({
      organizationId: "tenant-a",
      sessionId: "voice-1",
      transcript: "I need a Dubai trip",
      customerExternalId: "+919999999999",
      requestId: "voice-turn-1"
    });
    expect(outcome.acknowledgement).toContain("connecting");
    expect(agents.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "receptionist-1",
        conversationId: "conversation-1",
        source: expect.objectContaining({ type: "VOICE", providerCallId: "call-1" })
      })
    );
    expect(prisma.voiceSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeHandoffId: "handoff-1" } })
    );
  });

  it("keeps the same receptionist conversation for the next voice transcript", async () => {
    const { sessions, prisma } = service();
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      pluginInstallationId: "receptionist-1",
      pluginInstallation: {
        status: "ACTIVE",
        manifest: { capabilities: ["workforce.intake"] }
      }
    });
    const agents = {
      execute: vi.fn().mockResolvedValue({
        conversationId: "conversation-1",
        response: "Travel Employee: I noted 3 adults.",
        receptionist: { handoff: { id: "handoff-1" } }
      })
    };
    const turns = new VoiceReceptionistTurnService(prisma as never, sessions, agents as never);
    await turns.handleTranscript({
      organizationId: "tenant-a",
      sessionId: "voice-1",
      transcript: "3 adults",
      customerExternalId: "+919999999999",
      requestId: "voice-turn-2"
    });
    expect(agents.execute).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1", text: "3 adults" })
    );
  });

  it("rejects a voice session whose conversation is not owned by a receptionist", async () => {
    const { sessions, prisma } = service();
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conversation-1",
      pluginInstallationId: "travel-1",
      pluginInstallation: { status: "ACTIVE", manifest: { capabilities: ["travel.chat"] } }
    });
    const agents = { execute: vi.fn() };
    const turns = new VoiceReceptionistTurnService(prisma as never, sessions, agents as never);
    await expect(
      turns.handleTranscript({
        organizationId: "tenant-a",
        sessionId: "voice-1",
        transcript: "hello",
        customerExternalId: "+919999999999",
        requestId: "voice-turn-invalid"
      })
    ).rejects.toThrow("VOICE_RECEPTIONIST_SCOPE_INVALID");
    expect(agents.execute).not.toHaveBeenCalled();
  });
});
