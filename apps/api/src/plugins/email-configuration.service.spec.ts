import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmailConfigurationService } from "./email-configuration.service";
import { PluginSecretsEncryptionService } from "./plugin.runtime";

function harness() {
  const encryption = new PluginSecretsEncryptionService(Buffer.alloc(32, 7));
  let stored:
    | {
        pluginInstallationId: string;
        organizationId: string;
        configuration: Record<string, unknown>;
        encryptedSecrets: ReturnType<PluginSecretsEncryptionService["encrypt"]>;
        updatedAt: Date;
      }
    | null = null;

  const findUnique = vi.fn(async () => stored);
  const findFirst = vi.fn(async ({ where }: { where: { pluginInstallationId: string; organizationId: string } }) =>
    stored && stored.pluginInstallationId === where.pluginInstallationId && stored.organizationId === where.organizationId
      ? stored
      : null
  );
  const upsert = vi.fn(
    async ({
      create,
      update
    }: {
      create: { organizationId: string; pluginInstallationId: string; configuration: unknown; encryptedSecrets: unknown };
      update: { configuration: unknown; encryptedSecrets: unknown };
    }) => {
      stored = stored
        ? { ...stored, configuration: update.configuration as Record<string, unknown>, encryptedSecrets: update.encryptedSecrets as ReturnType<PluginSecretsEncryptionService["encrypt"]>, updatedAt: new Date() }
        : {
            pluginInstallationId: create.pluginInstallationId,
            organizationId: create.organizationId,
            configuration: create.configuration as Record<string, unknown>,
            encryptedSecrets: create.encryptedSecrets as ReturnType<PluginSecretsEncryptionService["encrypt"]>,
            updatedAt: new Date()
          };
      return stored;
    }
  );

  const prisma = {
    plugin: {
      findFirst: vi.fn(async () => ({ id: "plugin-1", organizationId: "org-1", deletedAt: null }))
    },
    emailDeliveryConfiguration: { findUnique, findFirst, upsert }
  } as unknown as PrismaService;

  const service = new EmailConfigurationService(prisma, encryption);
  return { service, prisma, findUnique, upsert };
}

describe("EmailConfigurationService", () => {
  it("reports not configured before anything is saved", async () => {
    const { service } = harness();
    const result = await service.get("org-1", "plugin-1");
    expect(result).toMatchObject({ configured: false, secrets: { password: { configured: false } } });
  });

  it("saves SMTP settings and the password, never returning the password itself back", async () => {
    const { service } = harness();
    const result = await service.update("org-1", "user-1", "plugin-1", {
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "sender@example.com",
      fromEmail: "sender@example.com",
      fromName: "Travel Desk",
      secrets: { password: "super-secret" }
    });

    expect(result.configured).toBe(true);
    expect(result.configuration).toMatchObject({ smtpHost: "smtp.example.com", fromEmail: "sender@example.com" });
    expect(result.secrets.password.configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("resolves a ready-to-use SmtpTransportConfig with the decrypted password", async () => {
    const { service } = harness();
    await service.update("org-1", "user-1", "plugin-1", {
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "sender@example.com",
      fromEmail: "sender@example.com",
      fromName: "Travel Desk",
      secrets: { password: "super-secret" }
    });

    const resolved = await service.resolve("org-1", "plugin-1");
    expect(resolved).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "sender@example.com",
      password: "super-secret",
      fromEmail: "sender@example.com",
      fromName: "Travel Desk"
    });
  });

  it("resolve() returns null (never throws) when nothing is configured for that installation", async () => {
    const { service } = harness();
    expect(await service.resolve("org-1", "plugin-1")).toBeNull();
  });

  it("resolve() returns null when a host is saved but no fromEmail is set yet (incomplete configuration)", async () => {
    const { service } = harness();
    await service.update("org-1", "user-1", "plugin-1", { smtpHost: "smtp.example.com" });
    expect(await service.resolve("org-1", "plugin-1")).toBeNull();
  });

  it("removing the password secret clears it without touching the other settings", async () => {
    const { service } = harness();
    await service.update("org-1", "user-1", "plugin-1", {
      smtpHost: "smtp.example.com",
      fromEmail: "sender@example.com",
      secrets: { password: "super-secret" }
    });
    const result = await service.update("org-1", "user-1", "plugin-1", { removeSecrets: ["password"] });

    expect(result.secrets.password.configured).toBe(false);
    expect(result.configuration).toMatchObject({ smtpHost: "smtp.example.com", fromEmail: "sender@example.com" });
    expect(await service.resolve("org-1", "plugin-1")).toMatchObject({ password: null });
  });

  it("translates a missing table into a stable safe error, matching PluginAiService's convention", async () => {
    const { service, prisma } = harness();
    (prisma.emailDeliveryConfiguration.findUnique as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("table does not exist", { code: "P2021", clientVersion: "6.19.3" })
    );

    await expect(
      service.update("org-1", "user-1", "plugin-1", { smtpHost: "smtp.example.com" })
    ).rejects.toMatchObject({ code: "DATABASE_SCHEMA_OUT_OF_DATE" });
  });
});
