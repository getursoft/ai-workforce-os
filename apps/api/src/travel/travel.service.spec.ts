import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { AgentService } from "../agents/agent.service";
import { TravelEmployeeService } from "./travel.service";

const auditLogger = { record: vi.fn() } as unknown as AuditEventLogger;
const travelPlugin = { id: "plugin-1", organizationId: "organization-1", slug: "travel-employee" };

describe("TravelEmployeeService.configuration", () => {
  it("rejects when the plugin does not exist or is not a Travel Employee installation", async () => {
    const prisma = { plugin: { findFirst: vi.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    await expect(service.configuration("organization-1", "plugin-1")).rejects.toMatchObject({
      message: "TRAVEL_EMPLOYEE_NOT_FOUND"
    });
  });

  it("returns safe defaults with configured=false when no configuration row exists yet", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      travelEmployeeConfiguration: { findFirst: vi.fn().mockResolvedValue(null) }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    const result = await service.configuration("organization-1", "plugin-1");
    expect(result.configured).toBe(false);
    expect(result.defaultCurrency).toBe("USD");
    expect(result.escalationContact).toBeDefined();
  });

  it("returns the persisted configuration when one exists", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      travelEmployeeConfiguration: {
        findFirst: vi.fn().mockResolvedValue({
          persona: "Warm and concise",
          welcomeMessage: "Welcome!",
          businessHoursTimezone: "Asia/Kolkata",
          businessHoursStart: "09:00",
          businessHoursEnd: "18:00",
          escalationContact: "ops@example.com",
          brandTone: "FORMAL",
          defaultCurrency: "INR",
          defaultLanguage: "en",
          updatedAt: new Date("2026-01-01T00:00:00.000Z")
        })
      }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    const result = await service.configuration("organization-1", "plugin-1");
    expect(result).toMatchObject({ configured: true, defaultCurrency: "INR", brandTone: "FORMAL" });
  });
});

describe("TravelEmployeeService.updateConfiguration", () => {
  it("creates a configuration row on first update and records an audit event", async () => {
    let created: Record<string, unknown> = {};
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      travelEmployeeConfiguration: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ pluginInstallationId: "plugin-1", ...created }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created = data;
          return { pluginInstallationId: "plugin-1", ...data };
        })
      }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    await service.updateConfiguration("organization-1", "user-1", "request-1", "plugin-1", {
      escalationContact: "help@example.com",
      defaultCurrency: "EUR"
    });
    expect(created).toMatchObject({ escalationContact: "help@example.com", defaultCurrency: "EUR" });
    expect(auditLogger.record).toHaveBeenCalledWith(
      "TRAVEL_CONFIGURATION_UPDATED",
      "request-1",
      expect.objectContaining({ organizationId: "organization-1", targetId: "plugin-1" })
    );
  });

  it("preserves fields not included in a partial update", async () => {
    let updated: Record<string, unknown> = {};
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      travelEmployeeConfiguration: {
        findFirst: vi.fn().mockImplementation(async () =>
          Object.keys(updated).length
            ? { id: "config-1", pluginInstallationId: "plugin-1", ...updated }
            : {
                id: "config-1",
                pluginInstallationId: "plugin-1",
                persona: "Original persona",
                welcomeMessage: "Welcome!",
                businessHoursTimezone: null,
                businessHoursStart: null,
                businessHoursEnd: null,
                escalationContact: "old@example.com",
                brandTone: "FRIENDLY",
                defaultCurrency: "USD",
                defaultLanguage: "en"
              }
        ),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updated = data;
          return { pluginInstallationId: "plugin-1", ...data };
        })
      }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    await service.updateConfiguration("organization-1", "user-1", "request-1", "plugin-1", {
      brandTone: "FORMAL"
    });
    expect(updated).toMatchObject({ persona: "Original persona", escalationContact: "old@example.com", brandTone: "FORMAL" });
  });
});

describe("TravelEmployeeService.state", () => {
  it("returns the persisted structured state from memory when available", async () => {
    const state = {
      destination: "Dubai",
      travelMonth: "December",
      durationDays: 5,
      passengers: 2,
      budgetAmount: 2000,
      budgetCurrency: "USD",
      stage: "CONFIRM_BOOKING",
      missingFields: []
    };
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "conversation-1" }) },
      agentMemory: { findFirst: vi.fn().mockResolvedValue({ value: state }) },
      conversationMessage: { findMany: vi.fn() }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    const result = await service.state("organization-1", "plugin-1", "conversation-1");
    expect(result).toEqual(state);
    expect((prisma as unknown as { conversationMessage: { findMany: ReturnType<typeof vi.fn> } }).conversationMessage.findMany).not.toHaveBeenCalled();
  });

  it("falls back to recomputing state from the transcript when no memory snapshot exists", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "conversation-1" }) },
      agentMemory: { findFirst: vi.fn().mockResolvedValue(null) },
      conversationMessage: {
        findMany: vi.fn().mockResolvedValue([
          { role: "USER", content: "My name is Alex. Dubai in December for 5 days, 2 adults, budget $2000" }
        ])
      }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    const result = await service.state("organization-1", "plugin-1", "conversation-1");
    expect(result.destination).toBe("Dubai");
    expect(result.stage).toBe("RECOMMEND_OPTIONS");
  });

  it("rejects when the conversation does not belong to this Travel Employee installation", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      conversation: { findFirst: vi.fn().mockResolvedValue(null) }
    } as unknown as PrismaService;
    const agents = {} as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    await expect(service.state("organization-1", "plugin-1", "conversation-1")).rejects.toMatchObject({
      message: "CONVERSATION_NOT_FOUND"
    });
  });
});

describe("TravelEmployeeService.resetConversation", () => {
  it("archives the conversation and records an audit event", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(travelPlugin) },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: "conversation-1" }) }
    } as unknown as PrismaService;
    const archive = vi.fn().mockResolvedValue({ id: "conversation-1", status: "ARCHIVED" });
    const agents = { archive } as unknown as AgentService;
    const service = new TravelEmployeeService(prisma, agents, auditLogger);
    const result = await service.resetConversation(
      "organization-1",
      "user-1",
      "request-1",
      "plugin-1",
      "conversation-1"
    );
    expect(archive).toHaveBeenCalledWith("organization-1", "conversation-1", "ARCHIVED");
    expect(result).toMatchObject({ status: "ARCHIVED" });
    expect(auditLogger.record).toHaveBeenCalledWith(
      "TRAVEL_CONVERSATION_RESET",
      "request-1",
      expect.objectContaining({ targetId: "conversation-1" })
    );
  });
});
