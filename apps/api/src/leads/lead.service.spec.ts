import { describe, expect, it } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { LeadService } from "./lead.service";

interface FakeInteraction {
  id: string;
  organizationId: string;
  conversationId: string | null;
  voiceSessionId: string | null;
  channel: "WEB_CHAT" | "WHATSAPP" | "VOICE";
}
interface FakeHandoff {
  organizationId: string;
  conversationId: string;
  targetConversationId: string;
}

function fakePrisma() {
  const leads: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const interactions: FakeInteraction[] = [];
  const handoffs: FakeHandoff[] = [];
  const users: Array<{ id: string; organizationId: string; deletedAt: null }> = [];
  let leadCounter = 0;
  let activityCounter = 0;

  const prisma = {
    lead: {
      findUnique: async ({ where }: { where: { leadReferenceId?: string } }) =>
        leads.find((l) => l.leadReferenceId === where.leadReferenceId) ?? null,
      findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { createdAt: string } }) => {
        const matches = leads.filter((l) => matchLead(l, where));
        if (!matches.length) return null;
        if (orderBy?.createdAt === "desc") return matches[matches.length - 1];
        return matches[0];
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => leads.filter((l) => matchLead(l, where)),
      count: async ({ where }: { where: Record<string, unknown> }) => leads.filter((l) => matchLead(l, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        leadCounter += 1;
        const row = { id: `lead-${leadCounter}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        leads.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = leads.find((l) => l.id === where.id);
        if (!row) throw new Error("lead not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      groupBy: async ({ where }: { where: Record<string, unknown> }) => {
        const matches = leads.filter((l) => matchLead(l, where));
        const byStatus = new Map<string, number>();
        for (const l of matches) byStatus.set(l.status as string, (byStatus.get(l.status as string) ?? 0) + 1);
        return [...byStatus.entries()].map(([status, count]) => ({ status, _count: { _all: count } }));
      }
    },
    leadActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activityCounter += 1;
        const row = { id: `activity-${activityCounter}`, createdAt: new Date(), ...data };
        activities.push(row);
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        activities.filter((a) => Object.entries(where).every(([k, v]) => a[k] === v))
    },
    interaction: {
      findFirst: async ({ where }: { where: { organizationId: string; conversationId?: string; voiceSessionId?: string } }) =>
        interactions.find(
          (i) =>
            i.organizationId === where.organizationId &&
            (where.conversationId === undefined || i.conversationId === where.conversationId) &&
            (where.voiceSessionId === undefined || i.voiceSessionId === where.voiceSessionId)
        ) ?? null
    },
    receptionistHandoff: {
      findFirst: async ({ where }: { where: { organizationId: string; targetConversationId: string } }) =>
        handoffs.find(
          (h) => h.organizationId === where.organizationId && h.targetConversationId === where.targetConversationId
        ) ?? null
    },
    user: {
      findFirst: async ({ where }: { where: { id: string; organizationId: string } }) =>
        users.find((u) => u.id === where.id && u.organizationId === where.organizationId) ?? null
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops)
  };

  function matchLead(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === "OR") {
        const clauses = value as Array<Record<string, unknown>>;
        if (!clauses.some((clause) => matchLead(row, clause))) return false;
        continue;
      }
      if (value && typeof value === "object" && "in" in (value as object)) {
        if (!(value as { in: unknown[] }).in.includes(row[key])) return false;
        continue;
      }
      if (row[key] !== value) return false;
    }
    return true;
  }

  return {
    prisma: prisma as unknown as PrismaService,
    leads,
    activities,
    interactions,
    handoffs,
    users
  };
}

describe("LeadService.captureFromChannel", () => {
  it("creates a new lead with a KRV-LD- reference and a CREATED activity", async () => {
    const { prisma, leads, activities } = fakePrisma();
    const service = new LeadService(prisma);
    const lead = await service.captureFromChannel({
      organizationId: "org-1",
      source: "WEB_CHAT",
      agentId: "travel-plugin-1",
      conversationId: "conversation-1",
      name: "Krishna",
      phone: "+919876543210",
      requirement: "Delhi to Dubai trip"
    });
    expect(lead.leadReferenceId).toMatch(/^KRV-LD-/);
    expect(lead.status).toBe("NEW");
    expect(lead.source).toBe("WEB_CHAT");
    expect(lead.agentId).toBe("travel-plugin-1");
    expect(leads).toHaveLength(1);
    expect(activities.some((a) => a.type === "CREATED" && a.leadId === lead.id)).toBe(true);
  });

  it("dedupes on the SAME conversationId — a second capture for the same conversation updates the existing lead, never creates a duplicate", async () => {
    const { prisma, leads } = fakePrisma();
    const service = new LeadService(prisma);
    const first = await service.captureFromChannel({
      organizationId: "org-1",
      source: "WEB_CHAT",
      conversationId: "conversation-1",
      phone: "+919876543210",
      requirement: "Initial enquiry"
    });
    const second = await service.captureFromChannel({
      organizationId: "org-1",
      source: "WEB_CHAT",
      conversationId: "conversation-1",
      phone: "+919876543210",
      requirement: "Updated enquiry with more detail"
    });
    expect(second.id).toBe(first.id);
    expect(second.requirement).toBe("Updated enquiry with more detail");
    expect(leads).toHaveLength(1);
  });

  it("prefers the resolved Interaction's channel over the caller-supplied fallback source", async () => {
    const { prisma, interactions } = fakePrisma();
    interactions.push({
      id: "interaction-1",
      organizationId: "org-1",
      conversationId: "conversation-1",
      voiceSessionId: null,
      channel: "WHATSAPP"
    });
    const service = new LeadService(prisma);
    const lead = await service.captureFromChannel({
      organizationId: "org-1",
      source: "WEB_CHAT",
      conversationId: "conversation-1",
      phone: "+919876543210",
      requirement: "Trip enquiry"
    });
    expect(lead.source).toBe("WHATSAPP");
    expect(lead.interactionId).toBe("interaction-1");
  });

  it("resolves a Receptionist-handoff specialist conversation back to its origin Interaction (see InteractionService.findOrCreate's channel-identity 'touch' branch)", async () => {
    const { prisma, interactions, handoffs } = fakePrisma();
    interactions.push({
      id: "interaction-1",
      organizationId: "org-1",
      conversationId: "receptionist-conversation",
      voiceSessionId: "voice-session-1",
      channel: "VOICE"
    });
    handoffs.push({
      organizationId: "org-1",
      conversationId: "receptionist-conversation",
      targetConversationId: "specialist-conversation"
    });
    const service = new LeadService(prisma);
    const lead = await service.captureFromChannel({
      organizationId: "org-1",
      source: "WEB_CHAT",
      conversationId: "specialist-conversation",
      phone: "+919876543210",
      requirement: "Trip enquiry via voice"
    });
    expect(lead.source).toBe("VOICE");
    expect(lead.interactionId).toBe("interaction-1");
  });

  it("never resolves a different organization's Interaction or lead (tenant isolation)", async () => {
    const { prisma, interactions } = fakePrisma();
    interactions.push({
      id: "interaction-org-b",
      organizationId: "org-B",
      conversationId: "shared-conversation-id",
      voiceSessionId: null,
      channel: "WHATSAPP"
    });
    const service = new LeadService(prisma);
    const leadA = await service.captureFromChannel({
      organizationId: "org-A",
      source: "WEB_CHAT",
      conversationId: "shared-conversation-id",
      phone: "+911111111111",
      requirement: "Org A enquiry"
    });
    // No org-A Interaction exists for this conversationId, so the fallback source is used — never org-B's.
    expect(leadA.source).toBe("WEB_CHAT");
    expect(leadA.interactionId).toBeNull();
    expect(leadA.organizationId).toBe("org-A");
  });
});

describe("LeadService manual lead + lifecycle", () => {
  it("creates a MANUAL lead and logs CREATED + ASSIGNED activity when assigned at creation", async () => {
    const { prisma, users } = fakePrisma();
    users.push({ id: "user-1", organizationId: "org-1", deletedAt: null });
    const service = new LeadService(prisma);
    const lead = await service.create("org-1", "actor-1", {
      name: "Arjun",
      phone: "+919812300000",
      assignedToUserId: "user-1"
    });
    expect(lead.source).toBe("MANUAL");
    expect(lead.assignedToUserId).toBe("user-1");
    const activity = await service.activity("org-1", lead.id);
    expect(activity.map((a) => a.type)).toEqual(expect.arrayContaining(["CREATED", "ASSIGNED"]));
  });

  it("update() logs STATUS_CHANGED (and CONVERTED) and stamps convertedAt only when status actually changes", async () => {
    const { prisma } = fakePrisma();
    const service = new LeadService(prisma);
    const lead = await service.create("org-1", "actor-1", { name: "Arjun" });
    const converted = await service.update("org-1", "actor-1", lead.id, { status: "CONVERTED" });
    expect(converted.status).toBe("CONVERTED");
    expect(converted.convertedAt).not.toBeNull();
    const activity = await service.activity("org-1", lead.id);
    expect(activity.map((a) => a.type)).toEqual(expect.arrayContaining(["STATUS_CHANGED", "CONVERTED"]));

    // Re-applying the SAME status is a no-op status change — only a plain UPDATED activity, no repeat
    // STATUS_CHANGED/CONVERTED noise.
    const before = activity.length;
    await service.update("org-1", "actor-1", lead.id, { status: "CONVERTED" });
    const after = await service.activity("org-1", lead.id);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.type).toBe("UPDATED");
  });

  it("assign() rejects assigning to a user outside the organization", async () => {
    const { prisma, users } = fakePrisma();
    users.push({ id: "user-other-org", organizationId: "org-2", deletedAt: null });
    const service = new LeadService(prisma);
    const lead = await service.create("org-1", "actor-1", { name: "Arjun" });
    await expect(service.assign("org-1", "actor-1", lead.id, "user-other-org")).rejects.toThrow();
  });

  it("get()/update() never find a lead belonging to a different organization (tenant isolation)", async () => {
    const { prisma } = fakePrisma();
    const service = new LeadService(prisma);
    const leadB = await service.create("org-B", "actor-1", { name: "Tenant B Customer" });
    await expect(service.get("org-A", leadB.id)).rejects.toThrow();
    await expect(service.update("org-A", "actor-1", leadB.id, { status: "LOST" })).rejects.toThrow();
  });
});
