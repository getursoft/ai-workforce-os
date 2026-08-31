import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import type { AgentService } from "../agents/agent.service";
import { ChannelMessageProcessor } from "./channel-message.processor";

const STALE_MS = 2 * 60 * 1000;

interface Row {
  id: string;
  organizationId: string;
  channelConnectionId: string;
  conversationId?: string | null;
  agentExecutionId?: string | null;
  direction: "INBOUND" | "OUTBOUND";
  status: "RECEIVED" | "PROCESSING" | "SENT" | "FAILED";
  providerMessageSid?: string | null;
  fromAddress: string;
  toAddress: string;
  body?: string | null;
  processingAttempts: number;
  nextAttemptAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

function claimable(row: Row, direction: "INBOUND" | "OUTBOUND", now: number): boolean {
  if (row.direction !== direction) return false;
  if (row.status === "PROCESSING") return now - row.updatedAt.getTime() >= STALE_MS;
  if (direction === "INBOUND") return row.status === "RECEIVED";
  return (
    row.status === "FAILED" && Boolean(row.nextAttemptAt && row.nextAttemptAt.getTime() <= now)
  );
}

function getRow(store: Map<string, Row>, id: string): Row {
  const row = store.get(id);
  if (!row) throw new Error(`Test fixture row not found: ${id}`);
  return row;
}

function createFakePrisma(
  rows: Row[],
  channels: Record<string, unknown>,
  conversations: Record<string, unknown>[]
) {
  const store = new Map(rows.map((r) => [r.id, r]));
  let created = 0;
  return {
    channelMessage: {
      findMany: vi.fn(async ({ where }: { where: { direction: "INBOUND" | "OUTBOUND" } }) => {
        const now = Date.now();
        return [...store.values()]
          .filter((row) => claimable(row, where.direction, now))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => ({ id: row.id }));
      }),
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { id: string; direction: "INBOUND" | "OUTBOUND" };
          data: Record<string, unknown>;
        }) => {
          const row = store.get(where.id);
          if (!row || !claimable(row, where.direction, Date.now())) return { count: 0 };
          if (data.status) row.status = data.status as Row["status"];
          const attempts = data.processingAttempts as { increment?: number } | undefined;
          if (attempts?.increment) row.processingAttempts += attempts.increment;
          row.updatedAt = new Date();
          return { count: 1 };
        }
      ),
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => store.get(id) ?? null
      ),
      update: vi.fn(
        async ({
          where: { id },
          data
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = store.get(id);
          if (!row) throw new Error("NOT_FOUND");
          Object.assign(row, data);
          return { ...row };
        }
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created++;
        const row: Row = {
          id: `outbound-${created}`,
          processingAttempts: 0,
          updatedAt: new Date(),
          createdAt: new Date(),
          nextAttemptAt: null,
          ...(data as Partial<Row>)
        } as Row;
        store.set(row.id, row);
        return { ...row };
      })
    },
    channelConnection: {
      findFirst: vi.fn(async ({ where: { id } }: { where: { id: string } }) => channels[id] ?? null)
    },
    conversation: {
      findFirst: vi.fn(
        async ({
          where
        }: {
          where: { channelConnectionId: string; externalUserId: string; status: string };
        }) =>
          conversations.find(
            (c) =>
              c.channelConnectionId === where.channelConnectionId &&
              c.externalUserId === where.externalUserId &&
              c.status === where.status
          ) ?? null
      )
    },
    store
  };
}

const security = { nodeEnvironment: "test" } as SecurityConfig;
const auditLogger = { record: vi.fn() } as unknown as AuditEventLogger;
const encryption = new PluginSecretsEncryptionService(randomBytes(32));

function activeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "channel-1",
    organizationId: "organization-1",
    status: "ACTIVE",
    pluginInstallationId: "agent-1",
    configuration: { accountSid: "AC" + "a".repeat(32), fromNumber: "+14155238886" },
    encryptedSecrets: encryption.encrypt({ authToken: "secret-token" }),
    pluginInstallation: { id: "agent-1", status: "ACTIVE" },
    ...overrides
  };
}

function inboundRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "inbound-1",
    organizationId: "organization-1",
    channelConnectionId: "channel-1",
    direction: "INBOUND",
    status: "RECEIVED",
    fromAddress: "whatsapp:+14155550100",
    toAddress: "whatsapp:+14155238886",
    body: "Hello",
    processingAttempts: 0,
    nextAttemptAt: null,
    updatedAt: new Date(),
    createdAt: new Date(),
    ...overrides
  };
}

describe("ChannelMessageProcessor.processOnce", () => {
  it("runs the agent, creates and sends an outbound reply, and marks both messages SENT", async () => {
    const prisma = createFakePrisma([inboundRow()], { "channel-1": activeChannel() }, []);
    const agents = {
      execute: vi.fn().mockResolvedValue({
        conversationId: "conversation-1",
        executionId: "execution-1",
        response: "Hi! How can I help?"
      })
    } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    (processor as unknown as { twilio: { sendWhatsAppMessage: () => Promise<unknown> } }).twilio = {
      sendWhatsAppMessage: vi
        .fn()
        .mockResolvedValue({ providerMessageSid: "SM_OUT_1", status: "queued" })
    };
    const processed = await processor.processOnce();
    expect(processed).toBe(1);
    expect(agents.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        text: "Hello",
        actor: { type: "CHANNEL", channelConnectionId: "channel-1", externalUserId: "+14155550100" }
      })
    );
    const inbound = getRow(prisma.store, "inbound-1");
    expect(inbound.status).toBe("SENT");
    const outbound = getRow(prisma.store, "outbound-1");
    expect(outbound.status).toBe("SENT");
    expect(outbound.body).toBe("Hi! How can I help?");
    expect(outbound.providerMessageSid).toBe("SM_OUT_1");
  });

  it("reuses the existing active conversation for the same external user instead of creating a new one", async () => {
    const prisma = createFakePrisma([inboundRow()], { "channel-1": activeChannel() }, [
      {
        id: "conversation-existing",
        channelConnectionId: "channel-1",
        externalUserId: "+14155550100",
        status: "ACTIVE"
      }
    ]);
    const agents = {
      execute: vi
        .fn()
        .mockResolvedValue({
          conversationId: "conversation-existing",
          executionId: "execution-2",
          response: "ok"
        })
    } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    (processor as unknown as { twilio: { sendWhatsAppMessage: () => Promise<unknown> } }).twilio = {
      sendWhatsAppMessage: vi
        .fn()
        .mockResolvedValue({ providerMessageSid: "SM_OUT_2", status: "queued" })
    };
    await processor.processOnce();
    expect(agents.execute).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-existing" })
    );
  });

  it("sends a receptionist-bound WhatsApp turn through the universal runtime exactly once", async () => {
    const channel = activeChannel({
      routingMode: "INTENT_ROUTER",
      processingAcknowledgementEnabled: true,
      pluginInstallation: {
        id: "agent-1",
        status: "ACTIVE",
        manifest: { capabilities: ["workforce.intake"] }
      }
    });
    const prisma = createFakePrisma(
      [inboundRow({ body: "Dubai trip plan karna hai" })],
      {
        "channel-1": channel
      },
      []
    );
    const agents = {
      execute: vi.fn().mockResolvedValue({
        conversationId: "receptionist-conversation",
        executionId: "receptionist-execution",
        response: "I'll connect you with Travel Employee."
      })
    } as unknown as AgentService;
    const employeeRouter = {
      route: vi.fn(),
      isGreeting: vi.fn(),
      buildReceptionistGreeting: vi.fn()
    };
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security,
      employeeRouter as never
    );
    (processor as unknown as { twilio: { sendWhatsAppMessage: () => Promise<unknown> } }).twilio = {
      sendWhatsAppMessage: vi
        .fn()
        .mockResolvedValue({ providerMessageSid: "SM_RECEPTIONIST", status: "queued" })
    };
    await processor.processOnce();
    expect(employeeRouter.route).not.toHaveBeenCalled();
    expect(agents.execute).toHaveBeenCalledTimes(1);
    expect(agents.execute).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", text: "Dubai trip plan karna hai" })
    );
    expect(prisma.channelMessage.create).toHaveBeenCalledTimes(1);
    expect(getRow(prisma.store, "outbound-1").body).toContain("Travel Employee");
  });

  it("does not run the agent when the channel is disabled, and terminally fails the message", async () => {
    const prisma = createFakePrisma(
      [inboundRow()],
      { "channel-1": activeChannel({ status: "DISABLED" }) },
      []
    );
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    await processor.processOnce();
    expect(agents.execute).not.toHaveBeenCalled();
    const inbound = getRow(prisma.store, "inbound-1");
    expect(inbound.status).toBe("FAILED");
    expect(inbound.nextAttemptAt).toBeNull();
  });

  it("does not run the agent when the bound agent is not active", async () => {
    const prisma = createFakePrisma(
      [inboundRow()],
      { "channel-1": activeChannel({ pluginInstallation: { id: "agent-1", status: "DISABLED" } }) },
      []
    );
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    await processor.processOnce();
    expect(agents.execute).not.toHaveBeenCalled();
    expect(getRow(prisma.store, "inbound-1").status).toBe("FAILED");
  });

  it("does not reprocess a message that is already PROCESSING and not stale (no duplicate execution)", async () => {
    const prisma = createFakePrisma(
      [inboundRow({ status: "PROCESSING", updatedAt: new Date() })],
      { "channel-1": activeChannel() },
      []
    );
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    const processed = await processor.processOnce();
    expect(processed).toBe(0);
    expect(agents.execute).not.toHaveBeenCalled();
  });

  it("retries a scheduled outbound send without re-invoking the agent runtime", async () => {
    const prisma = createFakePrisma(
      [
        {
          id: "outbound-retry-1",
          organizationId: "organization-1",
          channelConnectionId: "channel-1",
          direction: "OUTBOUND",
          status: "FAILED",
          fromAddress: "whatsapp:+14155238886",
          toAddress: "whatsapp:+14155550100",
          body: "Delayed reply",
          processingAttempts: 1,
          nextAttemptAt: new Date(Date.now() - 1000),
          updatedAt: new Date(),
          createdAt: new Date()
        }
      ],
      { "channel-1": activeChannel() },
      []
    );
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    (processor as unknown as { twilio: { sendWhatsAppMessage: () => Promise<unknown> } }).twilio = {
      sendWhatsAppMessage: vi
        .fn()
        .mockResolvedValue({ providerMessageSid: "SM_RETRY", status: "queued" })
    };
    const processed = await processor.processOnce();
    expect(processed).toBe(1);
    expect(agents.execute).not.toHaveBeenCalled();
    expect(getRow(prisma.store, "outbound-retry-1").status).toBe("SENT");
  });

  it("does not retry an outbound message whose retry budget was already exhausted (nextAttemptAt null)", async () => {
    const prisma = createFakePrisma(
      [
        {
          id: "outbound-dead-1",
          organizationId: "organization-1",
          channelConnectionId: "channel-1",
          direction: "OUTBOUND",
          status: "FAILED",
          fromAddress: "whatsapp:+14155238886",
          toAddress: "whatsapp:+14155550100",
          body: "Never delivered",
          processingAttempts: 5,
          nextAttemptAt: null,
          updatedAt: new Date(),
          createdAt: new Date()
        }
      ],
      { "channel-1": activeChannel() },
      []
    );
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    const processed = await processor.processOnce();
    expect(processed).toBe(0);
  });
});
