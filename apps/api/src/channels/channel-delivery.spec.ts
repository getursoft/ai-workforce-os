import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import type { AgentService } from "../agents/agent.service";
import { ChannelMessageProcessor } from "./channel-message.processor";
import { classifyProviderError } from "./channel.runtime";
import { MetaWebhookController } from "./meta-webhook.controller";
import * as metaWhatsAppClient from "./whatsapp/meta-whatsapp.client";
import { MetaProviderError } from "./whatsapp/meta-whatsapp.client";

const security = { nodeEnvironment: "test" } as SecurityConfig;
const auditLogger = { record: vi.fn() } as unknown as AuditEventLogger;
const encryption = new PluginSecretsEncryptionService(randomBytes(32));

describe("Sprint 6.7 — classifyProviderError", () => {
  it("classifies rate limiting as retryable", () => {
    expect(classifyProviderError("CHANNEL_PROVIDER_RATE_LIMITED")).toEqual({
      normalized: "RATE_LIMITED",
      retryable: true
    });
    expect(classifyProviderError("META_RATE_LIMITED").retryable).toBe(true);
  });

  it("classifies auth/credential failures as permanent", () => {
    expect(classifyProviderError("CHANNEL_CREDENTIALS_REQUIRED")).toEqual({
      normalized: "AUTH_FAILURE",
      retryable: false
    });
    expect(classifyProviderError("META_CREDENTIALS_REQUIRED").retryable).toBe(false);
    expect(classifyProviderError("CHANNEL_PROVIDER_AUTHENTICATION_FAILED").retryable).toBe(false);
  });

  it("classifies invalid recipient / rejected media as permanent", () => {
    expect(classifyProviderError("CHANNEL_PROVIDER_REJECTED").normalized).toBe("INVALID_RECIPIENT");
    expect(classifyProviderError("META_INVALID_RECIPIENT").retryable).toBe(false);
    expect(classifyProviderError("META_MEDIA_REJECTED")).toEqual({
      normalized: "MEDIA_REJECTED",
      retryable: false
    });
  });

  it("classifies timeouts and provider-unavailable as retryable", () => {
    expect(classifyProviderError("CHANNEL_PROVIDER_TIMEOUT").retryable).toBe(true);
    expect(classifyProviderError("CHANNEL_PROVIDER_UNAVAILABLE").retryable).toBe(true);
    expect(classifyProviderError("META_PROVIDER_UNAVAILABLE").retryable).toBe(true);
  });

  it("fails open (retryable) for an unrecognized code", () => {
    expect(classifyProviderError("SOME_NEW_PROVIDER_ERROR_CODE")).toEqual({
      normalized: "UNKNOWN",
      retryable: true
    });
  });
});

interface DeliveryRow {
  id: string;
  organizationId: string;
  channelConnectionId: string;
  conversationId?: string | null;
  direction: "INBOUND" | "OUTBOUND";
  status: "RECEIVED" | "PROCESSING" | "SENT" | "DELIVERED" | "FAILED";
  provider: string;
  providerMessageSid?: string | null;
  fromAddress: string;
  toAddress: string;
  body?: string | null;
  processingAttempts: number;
  nextAttemptAt: Date | null;
  errorCode?: string | null;
  updatedAt: Date;
  createdAt: Date;
  computedResponseText?: string | null;
}

const STALE_MS = 2 * 60 * 1000;

function claimableFor(row: DeliveryRow, direction: "INBOUND" | "OUTBOUND", now: number): boolean {
  if (row.direction !== direction) return false;
  if (row.status === "PROCESSING") return now - row.updatedAt.getTime() >= STALE_MS;
  if (direction === "INBOUND") return row.status === "RECEIVED";
  return row.status === "FAILED" && Boolean(row.nextAttemptAt && row.nextAttemptAt.getTime() <= now);
}

function buildFakePrisma(row: DeliveryRow) {
  const store = new Map<string, DeliveryRow>([[row.id, row]]);
  const attempts: Record<string, unknown>[] = [];
  return {
    channelMessage: {
      findMany: vi.fn(
        async ({
          where
        }: {
          where: { direction: "INBOUND" | "OUTBOUND"; status?: string; updatedAt?: { gt?: Date }; OR?: unknown };
        }) => {
          const now = Date.now();
          // Sprint 6.7 busy-identity pre-query shape (no OR, plain status+updatedAt) — nothing PROCESSING
          // in this single-row fixture other than the row under test, which findCandidateIds already
          // excludes via direction below.
          if (!where.OR && where.status === "PROCESSING") return [];
          return [...store.values()]
            .filter((candidate) => claimableFor(candidate, where.direction, now))
            .map((candidate) => ({ id: candidate.id }));
        }
      ),
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { id?: string; direction?: "INBOUND" | "OUTBOUND" };
          data: Record<string, unknown>;
        }) => {
          const current = where.id ? store.get(where.id) : store.get(row.id);
          if (!current) return { count: 0 };
          if (where.direction && !claimableFor(current, where.direction, Date.now())) return { count: 0 };
          if (data.status) current.status = data.status as DeliveryRow["status"];
          const attemptsInc = data.processingAttempts as { increment?: number } | undefined;
          if (attemptsInc?.increment) current.processingAttempts += attemptsInc.increment;
          current.updatedAt = new Date();
          return { count: 1 };
        }
      ),
      findUnique: vi.fn(async () => ({ ...store.get(row.id)! })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(store.get(row.id)!, data);
        return { ...store.get(row.id)! };
      })
    },
    channelDeliveryAttempt: {
      count: vi.fn(async () => attempts.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attempts.push(data);
        return data;
      })
    },
    channelConnection: {
      findFirst: vi.fn(async () => null)
    },
    conversation: { findFirst: vi.fn(async () => null) },
    // Phase 5.3 — ChannelMessageProcessor now checks organization status before any retry; every fixture
    // row here belongs to an ACTIVE org, consistent with every pre-existing test in this file.
    organization: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    store,
    attempts
  };
}

describe("Sprint 6.7 — per-attempt delivery history", () => {
  it("retryable failure then success records TWO delivery attempts under ONE ChannelMessage row", async () => {
    const row: DeliveryRow = {
      id: "outbound-retry-1",
      organizationId: "org-1",
      channelConnectionId: "channel-1",
      direction: "OUTBOUND",
      status: "FAILED",
      provider: "META_CLOUD_API",
      fromAddress: "whatsapp:+14155238886",
      toAddress: "whatsapp:+14155550100",
      body: "Hello",
      processingAttempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000),
      updatedAt: new Date(),
      createdAt: new Date()
    };
    const prisma = buildFakePrisma(row);
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    // Force a transient failure on the first attempt, then succeed on retry.
    let call = 0;
    prisma.channelConnection.findFirst = vi.fn(async () => ({
      id: "channel-1",
      organizationId: "org-1",
      provider: "META_CLOUD_API",
      phoneNumberId: "PN1",
      encryptedSecrets: encryption.encrypt({ accessToken: "token" }),
      deletedAt: null
    })) as never;
    const spy = vi.spyOn(metaWhatsAppClient, "sendMetaWhatsAppText").mockImplementation(async () => {
      call++;
      if (call === 1) throw new MetaProviderError("META_WHATSAPP_SEND_FAILED: timeout", "META_PROVIDER_UNAVAILABLE", 503);
      return { providerMessageId: "wamid.SECOND", status: "sent" };
    });
    try {
      const processed = await processor.processOnce();
      expect(processed).toBe(1);
      // First attempt failed (retryable), row should still be FAILED with a nextAttemptAt scheduled.
      expect(row.status).toBe("FAILED");
      expect(row.nextAttemptAt).not.toBeNull();
      expect(prisma.attempts).toHaveLength(1);
      expect(prisma.attempts[0]).toMatchObject({ success: false, retryable: true });

      // Second poll tick: nextAttemptAt is now due, retry succeeds.
      row.nextAttemptAt = new Date(Date.now() - 1000);
      const processedAgain = await processor.processOnce();
      expect(processedAgain).toBe(1);
      expect(row.status).toBe("SENT");
      expect(row.providerMessageSid).toBe("wamid.SECOND");
      expect(prisma.attempts).toHaveLength(2);
      expect(prisma.attempts[1]).toMatchObject({ success: true, providerRequestId: "wamid.SECOND" });
      expect(agents.execute).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("a permanent (non-retryable) failure records retryable:false and clears nextAttemptAt", async () => {
    const row: DeliveryRow = {
      id: "outbound-perm-1",
      organizationId: "org-1",
      channelConnectionId: "channel-1",
      direction: "OUTBOUND",
      status: "PROCESSING",
      provider: "META_CLOUD_API",
      fromAddress: "whatsapp:+14155238886",
      toAddress: "whatsapp:+14155550100",
      body: "Hello",
      processingAttempts: 0,
      nextAttemptAt: null,
      updatedAt: new Date(),
      createdAt: new Date()
    };
    const prisma = buildFakePrisma(row);
    prisma.channelConnection.findFirst = vi.fn(async () => ({
      id: "channel-1",
      organizationId: "org-1",
      provider: "META_CLOUD_API",
      phoneNumberId: "PN1",
      encryptedSecrets: encryption.encrypt({ accessToken: "token" }),
      deletedAt: null
    })) as never;
    const agents = { execute: vi.fn() } as unknown as AgentService;
    const processor = new ChannelMessageProcessor(
      prisma as never,
      agents,
      encryption,
      auditLogger,
      security
    );
    const spy = vi
      .spyOn(metaWhatsAppClient, "sendMetaWhatsAppText")
      .mockRejectedValue(
        new MetaProviderError("META_WHATSAPP_SEND_FAILED: bad number", "META_INVALID_RECIPIENT", 400)
      );
    try {
      await (
        processor as unknown as { handleOutboundRetry: (m: DeliveryRow) => Promise<void> }
      ).handleOutboundRetry(row);
      expect(row.status).toBe("FAILED");
      expect(row.nextAttemptAt).toBeNull();
      expect(prisma.attempts).toHaveLength(1);
      expect(prisma.attempts[0]).toMatchObject({ success: false, retryable: false, errorCode: "INVALID_RECIPIENT" });
    } finally {
      spy.mockRestore();
    }
  });
});

function fakeChannelConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "channel-1",
    organizationId: "org-1",
    provider: "META_CLOUD_API",
    status: "ACTIVE",
    encryptedSecrets: encryption.encrypt({}),
    pluginInstallation: { id: "agent-1", status: "ACTIVE" },
    ...overrides
  };
}

describe("Sprint 6.7 — Meta delivery-status callback: monotonic, idempotent", () => {
  function buildController(rows: Map<string, { status: string; errorCode?: string | null }>) {
    const prisma = {
      channelConnection: {
        findFirst: vi.fn(async () => fakeChannelConnection()),
        update: vi.fn(async () => ({}))
      },
      channelMessage: {
        updateMany: vi.fn(
          async ({
            where,
            data
          }: {
            where: { providerMessageSid: string; status?: { in: string[] } | string };
            data: Record<string, unknown>;
          }) => {
            const row = rows.get(where.providerMessageSid);
            if (!row) return { count: 0 };
            const allowed = where.status
              ? typeof where.status === "string"
                ? row.status === where.status
                : where.status.in.includes(row.status)
              : true;
            if (!allowed) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
          }
        )
      }
    };
    const processor = { trigger: vi.fn() } as unknown as ChannelMessageProcessor;
    const controller = new MetaWebhookController(prisma as never, encryption, processor);
    return { controller, prisma };
  }

  function statusPayload(id: string, status: string, errorCode?: string) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                statuses: [
                  {
                    id,
                    status,
                    ...(errorCode ? { errors: [{ code: errorCode, title: "failed" }] } : {})
                  }
                ]
              }
            }
          ]
        }
      ]
    };
  }

  it("advances SENT -> DELIVERED on a 'delivered' callback", async () => {
    const rows = new Map<string, { status: string; errorCode?: string | null }>([["wamid.1", { status: "SENT" }]]);
    const { controller } = buildController(rows);
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.1", "delivered"));
    expect(rows.get("wamid.1")?.status).toBe("DELIVERED");
  });

  it("a delayed/duplicate 'sent' callback does NOT regress an already-DELIVERED row", async () => {
    const rows = new Map<string, { status: string; errorCode?: string | null }>([["wamid.2", { status: "DELIVERED" }]]);
    const { controller } = buildController(rows);
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.2", "sent"));
    expect(rows.get("wamid.2")?.status).toBe("DELIVERED");
  });

  it("a duplicate 'delivered' callback is idempotent (no-op, stays DELIVERED)", async () => {
    const rows = new Map<string, { status: string; errorCode?: string | null }>([["wamid.3", { status: "DELIVERED" }]]);
    const { controller } = buildController(rows);
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.3", "delivered"));
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.3", "delivered"));
    expect(rows.get("wamid.3")?.status).toBe("DELIVERED");
  });

  it("moves PROCESSING/SENT to FAILED on a 'failed' callback with the provider error code", async () => {
    const rows = new Map<string, { status: string; errorCode?: string | null }>([["wamid.4", { status: "SENT" }]]);
    const { controller } = buildController(rows);
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.4", "failed", "131026"));
    expect(rows.get("wamid.4")?.status).toBe("FAILED");
    expect(rows.get("wamid.4")?.errorCode).toBe("131026");
  });

  it("a 'failed' callback for an already-DELIVERED row is ignored (does not regress it)", async () => {
    const rows = new Map<string, { status: string; errorCode?: string | null }>([["wamid.5", { status: "DELIVERED" }]]);
    const { controller } = buildController(rows);
    await controller.receiveWebhook("channel-1", undefined as never, statusPayload("wamid.5", "failed", "131026"));
    expect(rows.get("wamid.5")?.status).toBe("DELIVERED");
  });
});
