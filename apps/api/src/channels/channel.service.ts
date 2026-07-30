import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException
} from "@nestjs/common";
import { ChannelConnectionStatus, PluginStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { SECURITY_CONFIG, type SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { TwilioClient, TwilioProviderError } from "./channel.runtime";
import { verifyMetaCredentials } from "./whatsapp/meta-whatsapp.client";
import type { ChannelListQueryDto, ChannelConversationQueryDto, ChannelMessageQueryDto, CreateChannelDto, UpdateChannelDto, MetaWhatsAppConfigurationDto } from "./channel.dto";

type ChannelConnectionRow = Awaited<ReturnType<ChannelService["requireChannel"]>>;

@Injectable()
export class ChannelService {
  private readonly twilio = new TwilioClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly auditLogger: AuditEventLogger,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  async list(organizationId: string, query: ChannelListQueryDto) {
    const where: Prisma.ChannelConnectionWhereInput = { organizationId, deletedAt: null, ...(query.status ? { status: query.status } : {}), ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.channelConnection.findMany({ where, include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.channelConnection.count({ where })
    ]);
    return page(items.map((item) => this.sanitize(item)), total, query);
  }

  async get(organizationId: string, id: string) {
    return this.sanitize(await this.requireChannel(organizationId, id));
  }

  async create(organizationId: string, userId: string, requestId: string, dto: CreateChannelDto) {
    await this.requireActiveAgent(organizationId, dto.agentId);
    if (dto.provider === "META_CLOUD_API") return this.createMeta(organizationId, userId, requestId, dto);
    return this.createTwilio(organizationId, userId, requestId, dto);
  }

  private async createTwilio(organizationId: string, userId: string, requestId: string, dto: CreateChannelDto) {
    const config = dto.configuration as { accountSid?: string; authToken?: string; fromNumber?: string };
    const accountSid = config.accountSid?.trim();
    const authToken = config.authToken?.trim();
    const fromNumber = config.fromNumber?.trim();
    if (!accountSid || !authToken || !fromNumber) throw new BadRequestException("CHANNEL_CONFIGURATION_INCOMPLETE");
    const channel = await this.prisma.channelConnection.create({
      data: {
        organizationId, pluginInstallationId: dto.agentId, name: dto.name.trim(),
        provider: "TWILIO", channelType: "WHATSAPP", status: ChannelConnectionStatus.DRAFT,
        configuration: { accountSid, fromNumber } as Prisma.InputJsonValue,
        encryptedSecrets: this.secrets.encrypt({ authToken }) as unknown as Prisma.InputJsonValue,
        secretMetadata: secretMetadata(["authToken"]) as Prisma.InputJsonValue, createdByUserId: userId
      },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, channel.id, userId, requestId, "CHANNEL_CREATED");
    return this.sanitize(channel);
  }

  private async createMeta(organizationId: string, userId: string, requestId: string, dto: CreateChannelDto) {
    const config = dto.configuration as MetaWhatsAppConfigurationDto;
    const accessToken = config.accessToken?.trim();
    const appSecret = config.metaAppSecret?.trim();
    const phoneNumberId = config.phoneNumberId?.trim();
    const wabaId = config.whatsappBusinessAccountId?.trim();
    if (!accessToken || !phoneNumberId) throw new BadRequestException("META_CONFIGURATION_INCOMPLETE");
    if (phoneNumberId) {
      const existing = await this.prisma.channelConnection.findUnique({ where: { phoneNumberId } });
      if (existing && existing.organizationId !== organizationId) throw new ConflictException("PHONE_NUMBER_ALREADY_IN_USE");
    }
    const secrets: Record<string, string> = { accessToken };
    if (appSecret) secrets.appSecret = appSecret;
    if (config.webhookVerifyToken) secrets.webhookVerifyToken = config.webhookVerifyToken;
    const channel = await this.prisma.channelConnection.create({
      data: {
        organizationId, pluginInstallationId: dto.agentId, name: dto.name.trim(),
        provider: "META_CLOUD_API", channelType: "WHATSAPP", status: ChannelConnectionStatus.DRAFT,
        configuration: {
          metaAppId: config.metaAppId ?? null,
          apiVersion: config.apiVersion ?? "v22.0"
        } as Prisma.InputJsonValue,
        whatsappBusinessAccountId: wabaId ?? null,
        phoneNumberId: phoneNumberId ?? null,
        displayPhoneNumber: config.displayPhoneNumber ?? null,
        onboardingMode: "MANUAL",
        encryptedSecrets: this.secrets.encrypt(secrets) as unknown as Prisma.InputJsonValue,
        secretMetadata: secretMetadata(Object.keys(secrets)) as Prisma.InputJsonValue,
        createdByUserId: userId
      },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, channel.id, userId, requestId, "CHANNEL_CREATED");
    return this.sanitize(channel);
  }

  async update(organizationId: string, userId: string, requestId: string, id: string, dto: UpdateChannelDto) {
    const existing = await this.requireChannel(organizationId, id);
    const data: Record<string, unknown> = {};
    if (dto.name) data.name = dto.name.trim();
    if (dto.agentId) {
      await this.requireActiveAgent(organizationId, dto.agentId);
      data.pluginInstallationId = dto.agentId;
    }
    if (dto.configuration) {
      if (existing.provider === "META_CLOUD_API") {
        await this.updateMetaConfig(existing, dto.configuration as MetaWhatsAppConfigurationDto, data);
      } else {
        await this.updateTwilioConfig(existing, dto.configuration as { accountSid?: string; authToken?: string; fromNumber?: string }, data);
      }
    }
    const updated = await this.prisma.channelConnection.update({
      where: { id }, data: data as Prisma.ChannelConnectionUpdateInput,
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_UPDATED");
    return this.sanitize(updated);
  }

  private async updateTwilioConfig(existing: ChannelConnectionRow, config: Record<string, string | undefined>, data: Record<string, unknown>) {
    const accountSid = config.accountSid?.trim() ?? (existing.configuration as Record<string, unknown>)?.accountSid as string;
    const fromNumber = config.fromNumber?.trim() ?? (existing.configuration as Record<string, unknown>)?.fromNumber as string;
    data.configuration = { accountSid, fromNumber };
    if (config.authToken) {
      const decrypted = this.secrets.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload);
      const merged = { ...decrypted, authToken: config.authToken.trim() };
      data.encryptedSecrets = this.secrets.encrypt(merged) as unknown as Prisma.InputJsonValue;
    }
  }

  private async updateMetaConfig(existing: ChannelConnectionRow, config: MetaWhatsAppConfigurationDto, data: Record<string, unknown>) {
    const mergedConfig = { ...(existing.configuration as Record<string, unknown>) };
    if (config.metaAppId !== undefined) mergedConfig.metaAppId = config.metaAppId;
    if (config.apiVersion !== undefined) mergedConfig.apiVersion = config.apiVersion;
    data.configuration = mergedConfig as Prisma.InputJsonValue;
    if (config.whatsappBusinessAccountId !== undefined) data.whatsappBusinessAccountId = config.whatsappBusinessAccountId;
    if (config.phoneNumberId !== undefined) {
      if (config.phoneNumberId !== existing.phoneNumberId) {
        const conflict = await this.prisma.channelConnection.findUnique({ where: { phoneNumberId: config.phoneNumberId } });
        if (conflict && conflict.organizationId !== existing.organizationId) throw new ConflictException("PHONE_NUMBER_ALREADY_IN_USE");
      }
      data.phoneNumberId = config.phoneNumberId;
    }
    if (config.displayPhoneNumber !== undefined) data.displayPhoneNumber = config.displayPhoneNumber;
    if (config.accessToken || config.metaAppSecret || config.webhookVerifyToken) {
      const decrypted = existing.encryptedSecrets ? this.secrets.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload) : {};
      if (config.accessToken) decrypted.accessToken = config.accessToken.trim();
      if (config.metaAppSecret) decrypted.appSecret = config.metaAppSecret.trim();
      if (config.webhookVerifyToken) decrypted.webhookVerifyToken = config.webhookVerifyToken.trim();
      data.encryptedSecrets = this.secrets.encrypt(decrypted) as unknown as Prisma.InputJsonValue;
      data.secretMetadata = secretMetadata(Object.keys(decrypted)) as Prisma.InputJsonValue;
    }
  }

  async remove(organizationId: string, userId: string, requestId: string, id: string) {
    await this.requireChannel(organizationId, id);
    await this.prisma.channelConnection.update({ where: { id }, data: { deletedAt: new Date() } });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_REMOVED");
  }

  async test(organizationId: string, userId: string, requestId: string, id: string) {
    const channel = await this.requireChannel(organizationId, id);
    if (channel.provider === "META_CLOUD_API") return this.testMeta(channel, userId, requestId);
    return this.testTwilio(channel, userId, requestId);
  }

  private async testMeta(channel: ChannelConnectionRow, userId: string, requestId: string) {
    try {
      const decrypted = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
      const accessToken = decrypted.accessToken;
      const phoneNumberId = channel.phoneNumberId;
      if (!accessToken || !phoneNumberId) throw new Error("META_CONFIGURATION_INCOMPLETE");
      const result = await verifyMetaCredentials(phoneNumberId, accessToken);
      await this.markTestResult(channel.id, "connected", null, null);
      this.audit(channel.organizationId, channel.id, userId, requestId, "CHANNEL_TEST_SUCCESS");
      return { status: "connected", displayPhoneNumber: result.displayPhoneNumber };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown";
      await this.markTestResult(channel.id, "failed", "TEST_FAILED", msg);
      this.audit(channel.organizationId, channel.id, userId, requestId, "CHANNEL_TEST_FAILED");
      throw new BadRequestException("CHANNEL_TEST_FAILED: " + msg.slice(0, 200));
    }
  }

  private async testTwilio(channel: ChannelConnectionRow, userId: string, requestId: string) {
    const config = channel.configuration as Record<string, unknown>;
    const accountSid = config.accountSid as string;
    const decrypted = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    const authToken = decrypted.authToken;
    if (!accountSid || !authToken) throw new BadRequestException("CHANNEL_CONFIGURATION_INCOMPLETE");
    try {
      await this.twilio.verifyCredentials({ accountSid, authToken });
      await this.markTestResult(channel.id, "success", null, null);
      this.audit(channel.organizationId, channel.id, userId, requestId, "CHANNEL_TEST_SUCCESS");
      return { status: "success" };
    } catch (error) {
      const code = error instanceof TwilioProviderError ? error.code : "CHANNEL_PROVIDER_UNAVAILABLE";
      const upstreamStatus = error instanceof TwilioProviderError ? error.upstreamStatus : null;
      await this.markTestResult(channel.id, "failed", code, upstreamStatus != null ? String(upstreamStatus) : null);
      this.audit(channel.organizationId, channel.id, userId, requestId, "CHANNEL_TEST_FAILED");
      throw new BadRequestException(code);
    }
  }

  async enable(organizationId: string, userId: string, requestId: string, id: string) {
    const channel = await this.requireChannel(organizationId, id);
    if (channel.status === "ACTIVE") throw new ConflictException("CHANNEL_ALREADY_ACTIVE");
    const updated = await this.prisma.channelConnection.update({ where: { id }, data: { status: "ACTIVE" }, include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } } });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_ENABLED");
    return this.sanitize(updated);
  }

  async disable(organizationId: string, userId: string, requestId: string, id: string) {
    const channel = await this.requireChannel(organizationId, id);
    if (channel.status === "DISABLED") throw new ConflictException("CHANNEL_ALREADY_DISABLED");
    const updated = await this.prisma.channelConnection.update({ where: { id }, data: { status: "DISABLED" }, include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } } });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_DISABLED");
    return this.sanitize(updated);
  }

  async conversations(organizationId: string, id: string, query: ChannelConversationQueryDto) {
    await this.requireChannel(organizationId, id);
    const where: Prisma.ConversationWhereInput = { organizationId, channelConnectionId: id, deletedAt: null, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({ where, include: { _count: { select: { channelMessages: true } } }, orderBy: { updatedAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.conversation.count({ where })
    ]);
    return page(items, total, query);
  }

  async messages(organizationId: string, id: string, query: ChannelMessageQueryDto) {
    await this.requireChannel(organizationId, id);
    const where: Prisma.ChannelMessageWhereInput = { organizationId, channelConnectionId: id, ...(query.direction ? { direction: query.direction } : {}), ...(query.status ? { status: query.status } : {}), ...(query.conversationId ? { conversationId: query.conversationId } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.channelMessage.findMany({ where, orderBy: { createdAt: "desc" }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.channelMessage.count({ where })
    ]);
    return page(items, total, query);
  }

  webhookUrl(id: string, provider?: string): string {
    const path = provider === "TWILIO" ? "twilio/whatsapp/webhook" : "whatsapp/webhook";
    return `${this.security.apiPublicUrl}/api/v1/channels/${path}/${id}`;
  }

  private async markTestResult(id: string, status: string | null, errorCode: string | null, errorMessage: string | null) {
    await this.prisma.channelConnection.update({ where: { id }, data: { lastTestedAt: new Date(), lastTestStatus: status, lastErrorCode: errorCode, lastErrorMessage: errorMessage } });
  }

  private async requireActiveAgent(organizationId: string, pluginInstallationId: string) {
    const plugin = await this.prisma.plugin.findFirst({ where: { id: pluginInstallationId, organizationId, deletedAt: null } });
    if (!plugin) throw new NotFoundException("AGENT_NOT_FOUND");
    if (plugin.status !== PluginStatus.ACTIVE) throw new BadRequestException("AGENT_NOT_ACTIVE");
  }

  private async requireChannel(organizationId: string, id: string) {
    const channel = await this.prisma.channelConnection.findFirst({ where: { id, organizationId, deletedAt: null }, include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } } });
    if (!channel) throw new NotFoundException("CHANNEL_NOT_FOUND");
    return channel;
  }

  private sanitize(input: Record<string, unknown>) {
    const { encryptedSecrets, pluginInstallation, pluginInstallationId, ...rest } = input;
    const configuration = rest.configuration as Record<string, unknown> ?? {};
    let hasAuthToken = false;
    if (encryptedSecrets && typeof encryptedSecrets === "object" && (encryptedSecrets as Record<string, unknown>).iv) {
      try {
        const decrypted = this.secrets.decrypt(encryptedSecrets as EncryptedPayload);
        hasAuthToken = Boolean(decrypted.accessToken || decrypted.authToken);
      } catch {
        hasAuthToken = false;
      }
    }
    return {
      ...rest,
      agentId: pluginInstallationId,
      hasAuthToken,
      agent: pluginInstallation ?? null,
      configuration: { ...configuration, hasAuthToken },
      webhookUrl: this.webhookUrl(rest.id as string, rest.provider as string | undefined)
    };
  }

  private audit(organizationId: string, channelId: string, userId: string, requestId: string, event: string) {
    this.auditLogger.record(event, requestId, { organizationId, userId, targetId: channelId });
  }
}

function page(items: unknown[], total: number, query: { page: number; pageSize: number }) {
  return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
}

function secretMetadata(keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, { configured: true, updatedAt: new Date().toISOString() }]));
}
