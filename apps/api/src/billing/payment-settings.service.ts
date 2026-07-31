import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import type { RazorpayCredentials } from "./razorpay.service";

const GATEWAY = "RAZORPAY";

interface StoredPaymentSettings {
  keyId?: string;
}

export interface PaymentSettingsView {
  configured: boolean;
  keyId: string | null;
  keySecret: { configured: boolean; updatedAt: Date | null };
  updatedAt: Date | null;
}

export interface UpdatePaymentSettingsInput {
  keyId?: string;
  keySecret?: string;
  removeSecrets?: string[];
}

/**
 * Per-organization Razorpay credential storage — the Owner-only counterpart to EmailConfigurationService.
 * The key_id is stored in plain `configuration` (it's the publishable key Checkout.js needs on the
 * frontend); the key_secret only ever lives inside `encryptedSecrets`, never returned decrypted to the
 * client. CreditPurchaseService calls `resolve()` to get real credentials for a checkout; every other
 * caller only ever sees the masked `PaymentSettingsView`.
 */
@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService
  ) {}

  async get(organizationId: string): Promise<PaymentSettingsView> {
    const stored = await this.prisma.paymentGatewayConfiguration.findUnique({
      where: { organizationId_gateway: { organizationId, gateway: GATEWAY } }
    });
    if (!stored) {
      return { configured: false, keyId: null, keySecret: { configured: false, updatedAt: null }, updatedAt: null };
    }
    const settings = stored.configuration as StoredPaymentSettings;
    const keySecretConfigured = this.secretKeys(stored.encryptedSecrets).includes("keySecret");
    return {
      configured: Boolean(settings.keyId?.trim()) && keySecretConfigured,
      keyId: settings.keyId ?? null,
      keySecret: { configured: keySecretConfigured, updatedAt: stored.updatedAt },
      updatedAt: stored.updatedAt
    };
  }

  async update(organizationId: string, userId: string, dto: UpdatePaymentSettingsInput): Promise<PaymentSettingsView> {
    try {
      return await this.persistUpdate(organizationId, userId, dto);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2021" || error.code === "P2022")
      )
        throw new IdentityApplicationError(
          "DATABASE_SCHEMA_OUT_OF_DATE",
          "The database schema is not ready for payment gateway configuration."
        );
      throw error;
    }
  }

  private async persistUpdate(
    organizationId: string,
    userId: string,
    dto: UpdatePaymentSettingsInput
  ): Promise<PaymentSettingsView> {
    const existing = await this.prisma.paymentGatewayConfiguration.findUnique({
      where: { organizationId_gateway: { organizationId, gateway: GATEWAY } }
    });
    const oldSettings = (existing?.configuration ?? {}) as StoredPaymentSettings;
    const settings: StoredPaymentSettings = { ...oldSettings };
    if (dto.keyId !== undefined) settings.keyId = dto.keyId.trim();
    if (settings.keyId !== undefined && !settings.keyId)
      throw new IdentityApplicationError("PAYMENT_SETTINGS_INVALID", "The Razorpay Key ID cannot be empty.");

    const secrets = existing
      ? this.encryption.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload)
      : {};
    if (dto.keySecret?.trim()) secrets.keySecret = dto.keySecret.trim();
    for (const key of dto.removeSecrets ?? []) {
      if (key !== "keySecret") throw new IdentityApplicationError("PAYMENT_SETTINGS_INVALID", "Unknown secret.");
      delete secrets.keySecret;
    }
    const encrypted = this.encryption.encrypt(secrets);

    await this.prisma.paymentGatewayConfiguration.upsert({
      where: { organizationId_gateway: { organizationId, gateway: GATEWAY } },
      create: {
        organizationId,
        gateway: GATEWAY,
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
    return this.get(organizationId);
  }

  /** Resolves ready-to-use Razorpay credentials for a checkout — null when the organization hasn't
   *  configured both a key_id and key_secret yet, never throws for that expected "not configured" state
   *  (see CreditPurchaseService, which turns a null here into an honest PAYMENT_GATEWAY_NOT_CONFIGURED). */
  async resolve(organizationId: string): Promise<RazorpayCredentials | null> {
    const stored = await this.prisma.paymentGatewayConfiguration.findUnique({
      where: { organizationId_gateway: { organizationId, gateway: GATEWAY } }
    });
    if (!stored) return null;
    const settings = stored.configuration as StoredPaymentSettings;
    if (!settings.keyId?.trim()) return null;
    const secrets = this.encryption.decrypt(stored.encryptedSecrets as unknown as EncryptedPayload);
    if (!secrets.keySecret?.trim()) return null;
    return { keyId: settings.keyId.trim(), keySecret: secrets.keySecret.trim() };
  }

  private secretKeys(value: unknown) {
    try {
      return Object.keys(this.encryption.decrypt(value as EncryptedPayload));
    } catch {
      return [];
    }
  }
}
