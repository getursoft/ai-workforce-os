import { BadRequestException } from "@nestjs/common";
import { PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationService } from "../identity/application/services/authorization.service";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginAiService } from "../plugins/plugin-ai.service";
import type { ConnectorService } from "../connectors/connector.service";
import type { KnowledgeSearchService } from "../knowledge/knowledge.search";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { TRAVEL_EMPLOYEE_PLUGIN_SLUG } from "../travel/travel.runtime";
import { AgentService, type MemoryService } from "./agent.service";
import { CustomerIdentityService } from "../customer-identity/customer-identity.service";
import type { TravelLeadService } from "../travel/travel-lead.service";

/**
 * Regression coverage for the production bug where a brand-new conversation silently inherited a
 * previous customer's name/state. These tests exercise the real `CustomerIdentityService` (backed by
 * an in-memory fake `customerProfile` table) wired through the real `AgentService`, rather than a stub —
 * unlike `agent.service.spec.ts`, which stubs identity resolution out entirely since it isn't what those
 * tests are about.
 */

const SECURITY_CONFIG_STUB = {
  knowledge: { retrievalDebugLogging: false }
} as unknown as SecurityConfig;

interface FakeProfileRow {
  id: string;
  organizationId: string;
  identityType: string;
  externalId: string;
  displayName: string | null;
  preferences: unknown;
  currency: string | null;
  language: string | null;
  deletedAt: Date | null;
}

function fakeCustomerProfileTable() {
  const rows: FakeProfileRow[] = [];
  let counter = 0;
  return {
    rows,
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.find(
        (row) =>
          row.organizationId === where.organizationId &&
          row.identityType === where.identityType &&
          row.externalId === where.externalId &&
          !row.deletedAt
      ) ?? null
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update
      }: {
        where: {
          organizationId_identityType_externalId: {
            organizationId: string;
            identityType: string;
            externalId: string;
          };
        };
        create: Partial<FakeProfileRow>;
        update: Partial<FakeProfileRow>;
      }) => {
        const key = where.organizationId_identityType_externalId;
        const existing = rows.find(
          (row) =>
            row.organizationId === key.organizationId &&
            row.identityType === key.identityType &&
            row.externalId === key.externalId
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: FakeProfileRow = {
          id: `profile-${++counter}`,
          preferences: {},
          currency: null,
          language: null,
          deletedAt: null,
          displayName: null,
          organizationId: "",
          identityType: "",
          externalId: "",
          ...create
        };
        rows.push(row);
        return row;
      }
    )
  };
}

function travelPluginRow() {
  return {
    id: "plugin-installation-1",
    organizationId: "organization-1",
    status: PluginStatus.ACTIVE,
    slug: TRAVEL_EMPLOYEE_PLUGIN_SLUG,
    description: "Travel assistant",
    grantedPermissions: [],
    manifest: { tools: [] }
  };
}

function harness(customerProfileTable: ReturnType<typeof fakeCustomerProfileTable>) {
  const conversations: Array<{ id: string; data: Record<string, unknown> }> = [];
  let conversationCounter = 0;
  const prisma = {
    plugin: { findFirst: vi.fn().mockResolvedValue(travelPluginRow()) },
    travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) },
    agentMemory: { findFirst: vi.fn().mockResolvedValue(null) },
    conversation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `conversation-${++conversationCounter}`;
        conversations.push({ id, data });
        return { id, status: "ACTIVE", customerProfileId: data.customerProfileId ?? null };
      }),
      update: vi.fn().mockResolvedValue({})
    },
    conversationMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: { role: string } }) =>
        data.role === "ASSISTANT" ? { id: "assistant-message" } : { id: "user-message" }
      )
    },
    agentExecution: {
      create: vi.fn().mockResolvedValue({ id: "execution-1" }),
      update: vi.fn().mockResolvedValue({})
    },
    agentToolExecution: { create: vi.fn(), update: vi.fn() },
    customerProfile: customerProfileTable
  };
  const pluginAi = {
    resolveProvider: vi.fn().mockRejectedValue(new BadRequestException("AI_PROVIDER_NOT_CONFIGURED"))
  };
  const memories = { search: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue({}) };
  const customerIdentity = new CustomerIdentityService(prisma as unknown as PrismaService);
  const service = new AgentService(
    prisma as unknown as PrismaService,
    { getEffectivePermissions: vi.fn().mockResolvedValue([]) } as unknown as AuthorizationService,
    memories as unknown as MemoryService,
    pluginAi as unknown as PluginAiService,
    {
      toolHandlers: () => [],
      availableToolNames: vi.fn().mockResolvedValue([])
    } as unknown as ConnectorService,
    { search: vi.fn().mockResolvedValue([]) } as unknown as KnowledgeSearchService,
    customerIdentity,
    {
      createInternalLead: vi.fn().mockResolvedValue({ id: "lead-stub", reference: "TRV-STUB01" }),
      markCrmSyncStatus: vi.fn().mockResolvedValue(undefined)
    } as unknown as TravelLeadService,
    SECURITY_CONFIG_STUB
  );
  return { service, prisma, conversations };
}

describe("Customer Identity isolation (AgentService x CustomerIdentityService)", () => {
  it("never links a brand-new dashboard (USER actor) conversation to any customer profile — every fresh Run starts anonymous, even back-to-back for the same staff user", async () => {
    const { service, conversations } = harness(fakeCustomerProfileTable());
    await service.run("organization-1", "staff-user-1", "request-1", {
      pluginInstallationId: "plugin-installation-1",
      message: "My name is Krishna Pandey"
    });
    await service.run("organization-1", "staff-user-1", "request-2", {
      pluginInstallationId: "plugin-installation-1",
      message: "My name is Priya Sharma"
    });
    expect(conversations).toHaveLength(2);
    expect(conversations[0]?.data.customerProfileId).toBeNull();
    expect(conversations[1]?.data.customerProfileId).toBeNull();
  });

  it("a second brand-new conversation for a different customer never inherits a customer profile from an unrelated conversation", async () => {
    const table = fakeCustomerProfileTable();
    const { service, conversations } = harness(table);
    await service.execute({
      organizationId: "organization-1",
      agentId: "plugin-installation-1",
      actor: { type: "CHANNEL", channelConnectionId: "channel-1", externalUserId: "+15550001111" },
      text: "My name is Krishna Pandey",
      source: { type: "CHANNEL", channelId: "channel-1", externalUserId: "+15550001111" },
      requestId: "whatsapp-request-1"
    });
    // A different phone number is a different customer — must never resolve to Krishna's profile.
    const strangerConversation = await service.execute({
      organizationId: "organization-1",
      agentId: "plugin-installation-1",
      actor: { type: "CHANNEL", channelConnectionId: "channel-1", externalUserId: "+15559998888" },
      text: "Hello",
      source: { type: "CHANNEL", channelId: "channel-1", externalUserId: "+15559998888" },
      requestId: "whatsapp-request-2"
    });
    const stranger = conversations.find((row) => row.id === strangerConversation.conversationId);
    expect(stranger?.data.customerProfileId).toBeNull();
  });

  it("resolves a returning WhatsApp customer's prior profile on a brand-new conversation, without carrying over trip state — proves future WhatsApp compatibility without implementing WhatsApp itself", async () => {
    const table = fakeCustomerProfileTable();
    const { service, conversations } = harness(table);
    const first = await service.execute({
      organizationId: "organization-1",
      agentId: "plugin-installation-1",
      actor: { type: "CHANNEL", channelConnectionId: "channel-1", externalUserId: "+15550001111" },
      text: "My name is Krishna Pandey",
      source: { type: "CHANNEL", channelId: "channel-1", externalUserId: "+15550001111" },
      requestId: "whatsapp-request-1"
    });
    expect(first.status).toBe("COMPLETED");
    expect(table.upsert).toHaveBeenCalled();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.displayName).toBe("Krishna Pandey");

    // A brand-new conversation for the SAME phone number (e.g. the first one was later archived/reset) —
    // no conversationId is passed, so a fresh Conversation row is created with empty trip state/messages.
    const second = await service.execute({
      organizationId: "organization-1",
      agentId: "plugin-installation-1",
      actor: { type: "CHANNEL", channelConnectionId: "channel-1", externalUserId: "+15550001111" },
      text: "Hi again",
      source: { type: "CHANNEL", channelId: "channel-1", externalUserId: "+15550001111" },
      requestId: "whatsapp-request-2"
    });
    expect(second.status).toBe("COMPLETED");
    expect(conversations).toHaveLength(2);
    // First contact: identity was known (a phone number) but no profile existed yet — unresolved.
    expect(conversations[0]?.data.customerProfileId).toBeNull();
    // Second, brand-new conversation: same durable identity now resolves to the profile created in the
    // first conversation — the customer is recognized without either conversation leaking into the other.
    expect(conversations[1]?.data.customerProfileId).toBe(table.rows[0]?.id);
  });
});
