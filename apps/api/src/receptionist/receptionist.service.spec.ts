import { describe, expect, it, vi } from "vitest";
import { ReceptionistService } from "./receptionist.service";
import type { ReceptionistRouteDecision } from "./receptionist.types";

const route: ReceptionistRouteDecision = {
  routeType: "ROUTE",
  primaryEmployeeInstallationId: "travel-1",
  secondaryEmployeeInstallationIds: [],
  capability: "travel.booking",
  intent: "TRAVEL_REQUEST",
  confidence: 0.92,
  decisionSource: "DETERMINISTIC",
  reasonCode: "PROFILE_SIGNAL_MATCH",
  clarificationQuestion: null,
  handoffMode: "TRANSFER_SESSION"
};

function harness(options: { specialistFails?: boolean } = {}) {
  let activeHandoff: Record<string, unknown> | null = null;
  let conversationCreates = 0;
  let messageCreates = 0;
  let executionCreates = 0;
  let receptionistConversationMetadata: unknown = {};
  const prisma = {
    plugin: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "receptionist-1"
          ? {
              id: "receptionist-1",
              displayName: "AI Receptionist",
              manifest: { capabilities: ["workforce.intake"] }
            }
          : where.id === "travel-1"
            ? { id: "travel-1", displayName: "Travel Employee" }
            : null
      ),
      findMany: vi.fn()
    },
    pluginConfiguration: { findUnique: vi.fn().mockResolvedValue(null) },
    conversation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        conversationCreates++;
        if (conversationCreates === 1) receptionistConversationMetadata = data.metadata ?? {};
        return {
          id: conversationCreates === 1 ? "receptionist-conversation" : "travel-conversation",
          status: "ACTIVE",
          customerProfileId: null,
          ...data
        };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === "receptionist-conversation")
          return {
            id: "receptionist-conversation",
            status: "ACTIVE",
            customerProfileId: null,
            createdByUserId: "user-1",
            pluginInstallationId: "receptionist-1",
            metadata: receptionistConversationMetadata
          };
        if (where.id === "travel-conversation")
          return {
            id: "travel-conversation",
            status: "ACTIVE",
            customerProfileId: null,
            pluginInstallationId: "travel-1"
          };
        return null;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.metadata !== undefined) receptionistConversationMetadata = data.metadata;
        return { id: "receptionist-conversation", metadata: receptionistConversationMetadata };
      })
    },
    customerProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    organizationSetting: {
      findUnique: vi.fn().mockResolvedValue({ locale: "en", timezone: "UTC" })
    },
    conversationMessage: {
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `message-${++messageCreates}`,
        ...data
      })),
      findFirst: vi.fn()
    },
    conversationSummary: { findFirst: vi.fn().mockResolvedValue(null) },
    conversationAttachment: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    agentExecution: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `execution-${++executionCreates}`,
        ...data
      })),
      update: vi.fn().mockResolvedValue({})
    },
    receptionistHandoff: {
      findFirst: vi.fn(async () => activeHandoff),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        activeHandoff = {
          id: "handoff-1",
          targetEmployeeInstallationId: "travel-1",
          targetConversationId: "travel-conversation",
          routingIntent: "TRAVEL_REQUEST",
          routingCapability: "travel.booking",
          routingConfidence: 0.92,
          status: "WAITING_SPECIALIST",
          ...data
        };
        return activeHandoff;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        activeHandoff = { ...(activeHandoff ?? {}), ...data };
        return activeHandoff;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        activeHandoff = { ...(activeHandoff ?? {}), ...data };
        return { count: 1 };
      })
    }
  };
  const routing = {
    route: vi.fn(async (routeInput: unknown) => {
      void routeInput;
      return activeHandoff
        ? {
            ...route,
            routeType: "CONTINUE_HANDOFF" as const,
            decisionSource: "ACTIVE_HANDOFF" as const,
            reasonCode: "ACTIVE_HANDOFF_PRECEDENCE"
          }
        : route;
    })
  };
  const agents = {
    execute: options.specialistFails
      ? vi.fn().mockRejectedValue(new Error("provider detail must not leak"))
      : vi
          .fn()
          .mockResolvedValueOnce({
            executionId: "travel-execution-1",
            response: "When would you like to travel?"
          })
          .mockResolvedValueOnce({
            executionId: "travel-execution-2",
            response: "I noted 15 September."
          })
  };
  const workforce = { planDelegation: vi.fn().mockResolvedValue({}) };
  const observability = {
    withSpan: vi.fn(async (_context, _metadata, callback) =>
      callback({ traceId: "trace-1", spanId: "span-1", sampled: true })
    ),
    addAttribute: vi.fn(),
    linkTrace: vi.fn()
  };
  const pendingInputRegistry = { isSatisfiedBy: vi.fn().mockResolvedValue(false) };
  const receptionist = new ReceptionistService(
    prisma as never,
    routing as never,
    { list: vi.fn(), eligible: vi.fn() } as never,
    agents as never,
    workforce as never,
    { resolve: vi.fn().mockReturnValue({}), loadProfile: vi.fn().mockResolvedValue(null) } as never,
    observability as never,
    pendingInputRegistry as never
  );
  return { receptionist, prisma, routing, agents, workforce, observability, pendingInputRegistry };
}

function request(message: string, conversationId?: string) {
  return {
    organizationId: "tenant-a",
    agentId: "receptionist-1",
    ...(conversationId ? { conversationId } : {}),
    actor: { type: "USER" as const, userId: "user-1" },
    text: message,
    source: { type: "DASHBOARD" as const },
    requestId: `request-${message}`
  };
}

describe("ReceptionistService", () => {
  it("creates a durable specialist handoff and continues a short web follow-up in that conversation", async () => {
    const { receptionist, prisma, routing, agents, workforce } = harness();
    // Identity is unknown on a brand-new conversation, so the very first reply asks for the customer's
    // name instead of handing off immediately — no specialist call, no handoff row yet.
    const askName = await receptionist.execute(request("I want a Dubai trip"));
    expect(askName.conversationId).toBe("receptionist-conversation");
    expect(askName.receptionist.handoff).toBeNull();
    expect(askName.response).toMatch(/may I know your name/i);
    expect(agents.execute).not.toHaveBeenCalled();
    expect(prisma.receptionistHandoff.create).not.toHaveBeenCalled();

    // The name reply resumes the ORIGINAL "I want a Dubai trip" request — the customer never repeats it.
    const first = await receptionist.execute(request("Krishna", "receptionist-conversation"));
    expect(first.conversationId).toBe("receptionist-conversation");
    expect(first.receptionist.handoff?.targetDisplayName).toBe("Travel Employee");
    expect(first.response).toContain("When would you like to travel?");
    // Fix (Travel Booking Closure Pass — Phase 14/16/19): on WEB, the dashboard's own "Connected to X"
    // indicator (driven by `receptionist.handoff.targetDisplayName`, asserted above) already communicates
    // the handoff visually — repeating "I'll connect you with Travel Employee." in the text is redundant
    // there and was removed. WHATSAPP/VOICE (no visual indicator) still get a short acknowledgement — see
    // the "announces the handoff on WhatsApp" test below.
    expect(first.response).not.toContain("I'll connect you with Travel Employee.");
    expect(routing.route.mock.calls[1]?.[0]).toMatchObject({ message: "I want a Dubai trip" });
    expect(agents.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "travel-1",
        metadata: expect.objectContaining({ receptionistCustomerName: "Krishna" })
      })
    );
    expect(prisma.receptionistHandoff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "tenant-a",
          conversationId: "receptionist-conversation",
          targetConversationId: "travel-conversation",
          routingCapability: "travel.booking"
        })
      })
    );
    expect(workforce.planDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "tenant-a",
        targetEmployeeInstallationId: "travel-1"
      })
    );

    const followUp = await receptionist.execute(
      request("15 September", "receptionist-conversation")
    );
    // Fix (Travel Booking Closure Pass — Phase 14/16/19): a CONTINUE_HANDOFF turn never repeats the
    // "Travel Employee:" prefix or the connection announcement on any channel — the dashboard's own
    // "Connected to X" indicator (and, on other channels, the one-time acknowledgement already given on
    // the FIRST handoff turn) makes repeating it on every follow-up turn redundant. See
    // receptionist-handoff-presentation.spec.ts for the dedicated unit tests of this behavior.
    expect(followUp.response).toBe("I noted 15 September.");
    expect(followUp.response).not.toContain("I'll connect you with");
    expect(
      (routing.route.mock.calls[2]?.[0] as { currentHandoff?: unknown } | undefined)?.currentHandoff
    ).toEqual(
      expect.objectContaining({ id: "handoff-1", targetConversationId: "travel-conversation" })
    );
    expect(agents.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "travel-1",
        conversationId: "travel-conversation",
        text: "15 September"
      })
    );
    const receptionistAssistantMessages = prisma.conversationMessage.create.mock.calls.filter(
      ([argument]) =>
        argument.data.conversationId === "receptionist-conversation" &&
        argument.data.role === "ASSISTANT"
    );
    expect(receptionistAssistantMessages).toHaveLength(3);
  });

  it("returns a safe receptionist fallback when the specialist fails", async () => {
    const { receptionist, prisma } = harness({ specialistFails: true });
    await receptionist.execute(request("book a flight"));
    const result = await receptionist.execute(request("Krishna", "receptionist-conversation"));
    expect(result.response).toContain("temporarily unavailable");
    expect(result.response).not.toContain("provider detail");
    expect(prisma.receptionistHandoff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  // Sprint 6.5 — Part 24: unprompted, platform-level identity capture. Nobody asked "what's your name?"
  // in any of these — the customer just volunteers it, on the very first turn of a fresh conversation.
  describe("unprompted identity capture (Sprint 6.5)", () => {
    it("Test A/B: captures a bare name with nothing else asked, then seeds it into the specialist the very next turn without re-asking", async () => {
      const { receptionist, agents } = harness();
      const bareName = await receptionist.execute(request("Krishna"));
      // Nothing to route yet — no "may I know your name?" ask, no specialist call, no handoff.
      expect(bareName.response).not.toMatch(/may I know your name/i);
      expect(bareName.response).toContain("Krishna");
      expect(agents.execute).not.toHaveBeenCalled();
      expect(bareName.receptionist.handoff).toBeNull();

      const request2 = await receptionist.execute(request("I want to plan a trip", "receptionist-conversation"));
      // The name is already known — no re-ask, and it reaches the specialist in the SAME turn.
      expect(request2.response).not.toMatch(/may I know your name/i);
      expect(agents.execute).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ receptionistCustomerName: "Krishna" }) })
      );
    });

    it('Test C: "I\'m Krishna" (HIGH-confidence explicit intro) is captured on the first turn', async () => {
      const { receptionist, agents } = harness();
      const result = await receptionist.execute(request("I'm Krishna"));
      expect(result.response).toContain("Krishna");
      expect(result.response).not.toMatch(/may I know your name/i);
      expect(agents.execute).not.toHaveBeenCalled();
    });

    it('Test D: "Krishna here" is captured on the first turn', async () => {
      const { receptionist, agents } = harness();
      const result = await receptionist.execute(request("Krishna here"));
      expect(result.response).toContain("Krishna");
      expect(result.response).not.toMatch(/may I know your name/i);
      expect(agents.execute).not.toHaveBeenCalled();
    });

    it("identity-plus-content in one message is captured silently and the specialist is seeded the SAME turn", async () => {
      const { receptionist, agents } = harness();
      const result = await receptionist.execute(request("I'm Krishna and I want to plan a trip"));
      expect(result.response).not.toMatch(/may I know your name/i);
      expect(agents.execute).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ receptionistCustomerName: "Krishna" }) })
      );
    });

    it.each(["book it", "share pdf", "no thanks", "next month", "Dubai please", "three adults"])(
      'Test E: "%s" must NEVER become the customer name — falls through to the ordinary "may I know your name?" ask',
      async (text) => {
        const { receptionist, agents } = harness();
        const result = await receptionist.execute(request(text));
        expect(result.response).toMatch(/may I know your name/i);
        expect(agents.execute).not.toHaveBeenCalled();
      }
    );
  });

  // Sprint 6.6 — Part 9/29: a CLARIFY exchange must preserve the original ambiguous message so the
  // customer's short disambiguating reply is interpreted together with it, never routed alone.
  describe("CLARIFY preserves the original message (Sprint 6.6)", () => {
    function clarifyThenRouteHarness() {
      const built = harness();
      built.prisma.plugin.findFirst.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          ({
            "receptionist-1": { id: "receptionist-1", displayName: "AI Receptionist", manifest: { capabilities: ["workforce.intake"] } },
            "travel-1": { id: "travel-1", displayName: "Travel Employee" },
            "finance-1": { id: "finance-1", displayName: "Finance Employee" }
          })[where.id] ?? null
      );
      const clarifyDecision: ReceptionistRouteDecision = {
        routeType: "CLARIFY",
        primaryEmployeeInstallationId: null,
        secondaryEmployeeInstallationIds: ["travel-1", "finance-1"],
        capability: null,
        intent: null,
        confidence: 0.5,
        decisionSource: "DETERMINISTIC",
        reasonCode: "AMBIGUOUS_PROFILE_MATCH",
        clarificationQuestion: "Sure. Is this about Travel Employee, or Finance Employee?",
        handoffMode: null
      };
      built.routing.route.mockImplementation(async (routeInput: { message: string }) => {
        // A cold-start "budget" message alone is ambiguous; once the original text is combined with a
        // disambiguating reply that names one side, it's a clean ROUTE — exactly like the real deterministic
        // scorer would behave (this mock exists only to prove `receptionist.service.ts`'s OWN combine-and-
        // reroute mechanism works, not to reimplement scoring).
        if (/travel/i.test(routeInput.message)) return { ...route, reasonCode: "PROFILE_SIGNAL_MATCH" };
        if (/finance/i.test(routeInput.message))
          return { ...route, primaryEmployeeInstallationId: "finance-1", reasonCode: "PROFILE_SIGNAL_MATCH" };
        return clarifyDecision;
      });
      return built;
    }

    it("Test A: a bare disambiguating reply is combined with the original message, not routed alone", async () => {
      const { receptionist, routing, agents } = clarifyThenRouteHarness();
      // Identity captured first (Sprint 6.5 behavior) so the later ROUTE resolves straight to a handoff
      // instead of detouring through "may I know your name?" — keeping this test focused on CLARIFY
      // preservation specifically, not the (already separately tested) identity-defer flow.
      await receptionist.execute(request("Krishna"));
      const ambiguous = await receptionist.execute(
        request("I need help with the budget", "receptionist-conversation")
      );
      expect(ambiguous.receptionist.routeType).toBe("CLARIFY");
      expect(ambiguous.response).toContain("Travel Employee");

      const reply = await receptionist.execute(request("Travel", "receptionist-conversation"));
      // The routing call for the disambiguating turn must have seen the ORIGINAL message too, not "Travel"
      // alone — a bare "Travel" alone carries almost no scoring signal on its own in the real scorer.
      const secondRouteCall = routing.route.mock.calls[1]?.[0] as { message: string } | undefined;
      expect(secondRouteCall?.message).toContain("I need help with the budget");
      expect(secondRouteCall?.message).toContain("Travel");
      expect(reply.receptionist.handoff?.targetDisplayName).toBe("Travel Employee");
      expect(agents.execute).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("I need help with the budget") })
      );
    });

    it("Test D: a domain pivot mid-clarify resolves on the combined text's own strong signal, not the original candidates", async () => {
      const { receptionist, routing } = clarifyThenRouteHarness();
      await receptionist.execute(request("Krishna"));
      await receptionist.execute(request("I need help with the budget", "receptionist-conversation"));
      const pivot = await receptionist.execute(
        request("Forget this, I need Finance instead", "receptionist-conversation")
      );
      const secondRouteCall = routing.route.mock.calls[1]?.[0] as { message: string } | undefined;
      expect(secondRouteCall?.message).toContain("I need help with the budget");
      expect(secondRouteCall?.message).toContain("Finance");
      expect(pivot.receptionist.handoff?.targetDisplayName).toBe("Finance Employee");
    });
  });
});
