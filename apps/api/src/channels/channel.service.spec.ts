import { randomBytes } from "node:crypto";
import { PluginStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { ChannelService } from "./channel.service";
import { TwilioProviderError } from "./channel.runtime";

const encryption = new PluginSecretsEncryptionService(randomBytes(32));
const security = { apiPublicUrl: "https://api.example.com" } as SecurityConfig;
const auditLogger = { record: vi.fn() } as unknown as AuditEventLogger;

describe("ChannelService.create", () => {
  it("rejects when the bound agent is missing", async () => {
    const prisma = {
      plugin: { findFirst: vi.fn().mockResolvedValue(null) }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    await expect(
      service.create("organization-1", "user-1", "request-1", {
        name: "Travel WhatsApp",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: "agent-1",
        configuration: { accountSid: "AC" + "a".repeat(32), authToken: "secret-token", fromNumber: "+14155238886" }
      })
    ).rejects.toMatchObject({ message: "AGENT_NOT_FOUND" });
  });

  it("rejects when the bound agent is not active", async () => {
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({ id: "agent-1", status: PluginStatus.DISABLED })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    await expect(
      service.create("organization-1", "user-1", "request-1", {
        name: "Travel WhatsApp",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: "agent-1",
        configuration: { accountSid: "AC" + "a".repeat(32), authToken: "secret-token", fromNumber: "+14155238886" }
      })
    ).rejects.toMatchObject({ message: "AGENT_NOT_ACTIVE" });
  });

  it("rejects incomplete Twilio configuration", async () => {
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({ id: "agent-1", status: PluginStatus.ACTIVE })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    await expect(
      service.create("organization-1", "user-1", "request-1", {
        name: "Travel WhatsApp",
        provider: "TWILIO",
        channelType: "WHATSAPP",
        agentId: "agent-1",
        configuration: { accountSid: "AC" + "a".repeat(32) }
      })
    ).rejects.toMatchObject({ message: "CHANNEL_CONFIGURATION_INCOMPLETE" });
  });

  it("encrypts the auth token and never persists it in plaintext configuration", async () => {
    let stored: Record<string, unknown> = {};
    const prisma = {
      plugin: {
        findFirst: vi.fn().mockResolvedValue({ id: "agent-1", status: PluginStatus.ACTIVE })
      },
      channelConnection: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          stored = data;
          return {
            ...data,
            id: "channel-1",
            pluginInstallation: { id: "agent-1", displayName: "Travel Agent", status: "ACTIVE" }
          };
        })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    const result = await service.create("organization-1", "user-1", "request-1", {
      name: "Travel WhatsApp",
      provider: "TWILIO",
      channelType: "WHATSAPP",
      agentId: "agent-1",
      configuration: {
        accountSid: "AC" + "a".repeat(32),
        authToken: "super-secret-token",
        fromNumber: "+14155238886"
      }
    });
    expect(JSON.stringify(stored)).not.toContain("super-secret-token");
    expect(result.hasAuthToken).toBe(true);
    expect((result as Record<string, unknown>).authToken).toBeUndefined();
    expect(result.webhookUrl).toBe(
      "https://api.example.com/api/v1/channels/twilio/whatsapp/webhook/channel-1"
    );
  });
});

describe("ChannelService.update — secret preservation", () => {
  it("preserves the stored auth token when the update omits it", async () => {
    const encryptedSecrets = encryption.encrypt({ authToken: "original-secret" });
    let updatedData: Record<string, unknown> = {};
    const prisma = {
      channelConnection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel-1",
          organizationId: "organization-1",
          configuration: { accountSid: "AC" + "a".repeat(32), fromNumber: "+14155238886" },
          encryptedSecrets,
          secretMetadata: { authToken: { configured: true } },
          pluginInstallation: { id: "agent-1", displayName: "Travel Agent", status: "ACTIVE" }
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updatedData = data;
          return {
            id: "channel-1",
            configuration: data.configuration,
            encryptedSecrets: data.encryptedSecrets,
            secretMetadata: data.secretMetadata,
            pluginInstallationId: "agent-1",
            pluginInstallation: { id: "agent-1", displayName: "Travel Agent", status: "ACTIVE" }
          };
        })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    const result = await service.update("organization-1", "user-1", "request-1", "channel-1", {
      name: "Renamed channel"
    });
    expect(result.hasAuthToken).toBe(true);
    const decrypted = encryption.decrypt(
      updatedData.encryptedSecrets as Parameters<typeof encryption.decrypt>[0]
    );
    expect(decrypted.authToken).toBe("original-secret");
  });

  it("replaces the auth token only when a non-empty value is provided", async () => {
    const encryptedSecrets = encryption.encrypt({ authToken: "original-secret" });
    let updatedData: Record<string, unknown> = {};
    const prisma = {
      channelConnection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel-1",
          organizationId: "organization-1",
          configuration: { accountSid: "AC" + "a".repeat(32), fromNumber: "+14155238886" },
          encryptedSecrets,
          secretMetadata: { authToken: { configured: true } },
          pluginInstallation: { id: "agent-1", displayName: "Travel Agent", status: "ACTIVE" }
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updatedData = data;
          return { id: "channel-1", ...data, pluginInstallation: { id: "agent-1", displayName: "x", status: "ACTIVE" } };
        })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    await service.update("organization-1", "user-1", "request-1", "channel-1", {
      configuration: { authToken: "brand-new-secret" }
    });
    const decrypted = encryption.decrypt(
      updatedData.encryptedSecrets as Parameters<typeof encryption.decrypt>[0]
    );
    expect(decrypted.authToken).toBe("brand-new-secret");
  });
});

describe("ChannelService.test", () => {
  it("maps provider failures to a safe error code and records the failure without message leakage", async () => {
    const secretValue = "s3cr3t-auth-token-value-xyz";
    const encryptedSecrets = encryption.encrypt({ authToken: secretValue });
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      channelConnection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "channel-1",
          organizationId: "organization-1",
          configuration: { accountSid: "AC" + "a".repeat(32), fromNumber: "+14155238886" },
          encryptedSecrets,
          pluginInstallation: { id: "agent-1", displayName: "Travel Agent", status: "ACTIVE" }
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return {};
        })
      }
    } as unknown as PrismaService;
    const service = new ChannelService(prisma, encryption, auditLogger, security);
    // Force the internal Twilio client to fail deterministically.
    (service as unknown as { twilio: { verifyCredentials: () => Promise<never> } }).twilio = {
      verifyCredentials: () =>
        Promise.reject(new TwilioProviderError("CHANNEL_PROVIDER_AUTHENTICATION_FAILED", 401))
    };
    await expect(service.test("organization-1", "user-1", "request-1", "channel-1")).rejects.toMatchObject(
      { message: "CHANNEL_PROVIDER_AUTHENTICATION_FAILED" }
    );
    expect(updates[0]).toMatchObject({
      lastTestStatus: "FAILED",
      lastErrorCode: "CHANNEL_PROVIDER_AUTHENTICATION_FAILED"
    });
    expect(JSON.stringify(updates[0])).not.toContain(secretValue);
  });
});
