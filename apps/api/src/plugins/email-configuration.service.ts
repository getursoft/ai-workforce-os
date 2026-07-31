import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import type { UpdateEmailConfigurationDto } from "./plugin.dto";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "./plugin.runtime";
import type { SmtpTransportConfig } from "../notifications/email.service";

interface StoredEmailSettings {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  fromEmail?: string;
  fromName?: string;
}

/**
 * Per-employee-installation SMTP configuration — the "Employee Configuration" counterpart to
 * PluginAiService, but for outbound email delivery (ticket PDFs, resends) instead of the AI provider.
 * Mirrors PluginAiService's storage shape exactly: non-secret settings in `configuration`, the SMTP
 * password only ever inside `encryptedSecrets`, never returned decrypted to the client.
 */
@Injectable()
export class EmailConfigurationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService
  ) {}

  async get(organizationId: string, pluginId: string) {
    await this.plugin(organizationId, pluginId);
    const stored = await this.prisma.emailDeliveryConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    if (!stored)
      return {
        pluginInstallationId: pluginId,
        configured: false,
        configuration: {},
        secrets: { password: { configured: false, updatedAt: null } },
        updatedAt: null
      };
    return {
      pluginInstallationId: pluginId,
      configured: true,
      configuration: stored.configuration,
      secrets: {
        password: {
          configured: this.secretKeys(stored.encryptedSecrets).includes("password"),
          updatedAt: stored.updatedAt
        }
      },
      updatedAt: stored.updatedAt
    };
  }

  async update(organizationId: string, userId: string, pluginId: string, dto: UpdateEmailConfigurationDto) {
    try {
      return await this.persistUpdate(organizationId, userId, pluginId, dto);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2021" || error.code === "P2022")
      )
        throw new IdentityApplicationError(
          "DATABASE_SCHEMA_OUT_OF_DATE",
          "The database schema is not ready for email delivery configuration."
        );
      throw error;
    }
  }

  private async persistUpdate(
    organizationId: string,
    userId: string,
    pluginId: string,
    dto: UpdateEmailConfigurationDto
  ) {
    await this.plugin(organizationId, pluginId);
    const existing = await this.prisma.emailDeliveryConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    const oldSettings = (existing?.configuration ?? {}) as StoredEmailSettings;
    const settings: StoredEmailSettings = { ...oldSettings };
    for (const key of ["smtpHost", "smtpUser", "fromEmail", "fromName"] as const)
      if (dto[key] !== undefined) settings[key] = dto[key];
    if (dto.smtpPort !== undefined) settings.smtpPort = dto.smtpPort;
    if (dto.smtpSecure !== undefined) settings.smtpSecure = dto.smtpSecure;
    this.validate(settings);
    const secrets = existing
      ? this.encryption.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload)
      : {};
    if (dto.secrets?.password?.trim()) secrets.password = dto.secrets.password.trim();
    for (const key of dto.removeSecrets ?? []) {
      if (key !== "password") throw new BadRequestException("EMAIL_SECRET_INVALID");
      delete secrets.password;
    }
    const encrypted = this.encryption.encrypt(secrets);
    await this.prisma.emailDeliveryConfiguration.upsert({
      where: { pluginInstallationId: pluginId },
      create: {
        organizationId,
        pluginInstallationId: pluginId,
        configuration: settings as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encrypted as unknown as Prisma.InputJsonValue,
        updatedBy: userId
      },
      update: {
        configuration: settings as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encrypted as unknown as Prisma.InputJsonValue,
        updatedBy: userId
      }
    });
    return this.get(organizationId, pluginId);
  }

  /** Resolves the ready-to-use SMTP transport config for a booking's plugin installation — null when
   *  nothing is configured for that installation (the caller falls back to process-wide SMTP_* env vars,
   *  see DeliveryRecorderService), never throws for the "not configured" case since that's an expected,
   *  common state, not an error. */
  async resolve(organizationId: string, pluginInstallationId: string): Promise<SmtpTransportConfig | null> {
    const stored = await this.prisma.emailDeliveryConfiguration.findFirst({
      where: { pluginInstallationId, organizationId }
    });
    if (!stored) return null;
    const settings = stored.configuration as StoredEmailSettings;
    if (!settings.smtpHost?.trim() || !settings.fromEmail?.trim()) return null;
    const secrets = this.encryption.decrypt(stored.encryptedSecrets as unknown as EncryptedPayload);
    return {
      host: settings.smtpHost.trim(),
      port: settings.smtpPort ?? 587,
      secure: settings.smtpSecure ?? settings.smtpPort === 465,
      user: settings.smtpUser?.trim() || null,
      password: secrets.password ?? null,
      fromEmail: settings.fromEmail.trim(),
      fromName: settings.fromName?.trim() || null
    };
  }

  private async plugin(organizationId: string, id: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!plugin)
      throw new IdentityApplicationError("PLUGIN_NOT_FOUND", "Plugin installation was not found.");
    return plugin;
  }

  private validate(settings: StoredEmailSettings) {
    if (settings.smtpPort !== undefined && (settings.smtpPort < 1 || settings.smtpPort > 65535))
      throw new IdentityApplicationError(
        "EMAIL_CONFIGURATION_INVALID",
        "The email delivery configuration is invalid."
      );
    if (settings.fromEmail !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.fromEmail))
      throw new IdentityApplicationError(
        "EMAIL_CONFIGURATION_INVALID",
        "The email delivery configuration is invalid."
      );
  }

  private secretKeys(value: unknown) {
    try {
      return Object.keys(this.encryption.decrypt(value as EncryptedPayload));
    } catch {
      return [];
    }
  }
}
