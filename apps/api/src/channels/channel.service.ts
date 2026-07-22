import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ChannelConnectionStatus, PluginStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { TwilioClient, TwilioProviderError } from "./channel.runtime";
import type {
  ChannelConversationQueryDto,
  ChannelListQueryDto,
  ChannelMessageQueryDto,
  CreateChannelDto,
  UpdateChannelDto
} from "./channel.dto";

type StoredConfiguration = { accountSid?: string; fromNumber?: string };
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
    const where: Prisma.ChannelConnectionWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { name: { contains: query.search, mode: "insensitive" } } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.channelConnection.findMany({
        where,
        include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.channelConnection.count({ where })
    ]);
    return page(
      items.map((item) => this.sanitize(item)),
      total,
      query
    );
  }

  async get(organizationId: string, id: string) {
    return this.sanitize(await this.requireChannel(organizationId, id));
  }

  async create(organizationId: string, userId: string, requestId: string, dto: CreateChannelDto) {
    await this.requireActiveAgent(organizationId, dto.agentId);
    const accountSid = dto.configuration.accountSid?.trim();
    const authToken = dto.configuration.authToken?.trim();
    const fromNumber = dto.configuration.fromNumber?.trim();
    if (!accountSid || !authToken || !fromNumber)
      throw new BadRequestException("CHANNEL_CONFIGURATION_INCOMPLETE");
    const channel = await this.prisma.channelConnection.create({
      data: {
        organizationId,
        pluginInstallationId: dto.agentId,
        name: dto.name.trim(),
        provider: "TWILIO",
        channelType: "WHATSAPP",
        status: ChannelConnectionStatus.DRAFT,
        configuration: { accountSid, fromNumber } as Prisma.InputJsonValue,
        encryptedSecrets: this.secrets.encrypt({ authToken }) as unknown as Prisma.InputJsonValue,
        secretMetadata: secretMetadata(["authToken"]) as Prisma.InputJsonValue,
        createdByUserId: userId
      },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, channel.id, userId, requestId, "CHANNEL_CREATED");
    return this.sanitize(channel);
  }

  async update(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: UpdateChannelDto
  ) {
    const existing = await this.requireChannel(organizationId, id);
    if (dto.agentId) await this.requireActiveAgent(organizationId, dto.agentId);
    const oldConfiguration = (existing.configuration ?? {}) as StoredConfiguration;
    const accountSid = dto.configuration?.accountSid?.trim() || oldConfiguration.accountSid;
    const fromNumber = dto.configuration?.fromNumber?.trim() || oldConfiguration.fromNumber;
    const secrets = this.secrets.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload);
    const newAuthToken = dto.configuration?.authToken?.trim();
    if (newAuthToken) secrets.authToken = newAuthToken;
    const channel = await this.prisma.channelConnection.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.agentId ? { pluginInstallationId: dto.agentId } : {}),
        configuration: { accountSid, fromNumber } as Prisma.InputJsonValue,
        encryptedSecrets: this.secrets.encrypt(secrets) as unknown as Prisma.InputJsonValue,
        secretMetadata: secretMetadata(Object.keys(secrets)) as Prisma.InputJsonValue
      },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_UPDATED");
    return this.sanitize(channel);
  }

  async remove(organizationId: string, userId: string, requestId: string, id: string) {
    await this.requireChannel(organizationId, id);
    await this.prisma.channelConnection.update({
      where: { id },
      data: { status: ChannelConnectionStatus.DISABLED, deletedAt: new Date() }
    });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_DELETED");
  }

  async enable(organizationId: string, userId: string, requestId: string, id: string) {
    const channel = await this.requireChannel(organizationId, id);
    await this.requireActiveAgent(organizationId, channel.pluginInstallationId);
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    if (!secrets.authToken) throw new ConflictException("CHANNEL_CREDENTIALS_REQUIRED");
    const updated = await this.prisma.channelConnection.update({
      where: { id },
      data: { status: ChannelConnectionStatus.ACTIVE },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_ENABLED");
    return this.sanitize(updated);
  }

  async disable(organizationId: string, userId: string, requestId: string, id: string) {
    await this.requireChannel(organizationId, id);
    const updated = await this.prisma.channelConnection.update({
      where: { id },
      data: { status: ChannelConnectionStatus.DISABLED },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    this.audit(organizationId, id, userId, requestId, "CHANNEL_DISABLED");
    return this.sanitize(updated);
  }

  async test(organizationId: string, userId: string, requestId: string, id: string) {
    const channel = await this.requireChannel(organizationId, id);
    const configuration = (channel.configuration ?? {}) as StoredConfiguration;
    const secrets = this.secrets.decrypt(channel.encryptedSecrets as unknown as EncryptedPayload);
    if (!configuration.accountSid || !configuration.fromNumber || !secrets.authToken)
      throw new ConflictException("CHANNEL_CREDENTIALS_REQUIRED");
    try {
      await this.twilio.verifyCredentials({
        accountSid: configuration.accountSid,
        authToken: secrets.authToken
      });
      await this.markTestResult(id, "SUCCEEDED", null, null);
      this.audit(organizationId, id, userId, requestId, "CHANNEL_TESTED");
      return { success: true };
    } catch (error) {
      const code =
        error instanceof TwilioProviderError ? error.code : "CHANNEL_PROVIDER_UNAVAILABLE";
      await this.markTestResult(id, "FAILED", code, providerTestMessage(code));
      this.audit(organizationId, id, userId, requestId, "CHANNEL_TESTED");
      throw new ConflictException(code);
    }
  }

  async conversations(organizationId: string, id: string, query: ChannelConversationQueryDto) {
    await this.requireChannel(organizationId, id);
    const where: Prisma.ConversationWhereInput = {
      organizationId,
      channelConnectionId: id,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where,
        select: {
          id: true,
          externalUserId: true,
          status: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } }
        },
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.conversation.count({ where })
    ]);
    return page(items, total, query);
  }

  async messages(organizationId: string, id: string, query: ChannelMessageQueryDto) {
    await this.requireChannel(organizationId, id);
    const where: Prisma.ChannelMessageWhereInput = {
      organizationId,
      channelConnectionId: id,
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.channelMessage.findMany({
        where,
        select: {
          id: true,
          conversationId: true,
          direction: true,
          status: true,
          fromAddress: true,
          toAddress: true,
          body: true,
          mediaMetadata: true,
          errorCode: true,
          createdAt: true,
          receivedAt: true,
          sentAt: true
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.channelMessage.count({ where })
    ]);
    return page(items, total, query);
  }

  webhookUrl(id: string): string {
    return `${this.security.apiPublicUrl}/api/v1/channels/twilio/whatsapp/webhook/${id}`;
  }

  private async markTestResult(
    id: string,
    status: "SUCCEEDED" | "FAILED",
    errorCode: string | null,
    errorMessage: string | null
  ) {
    await this.prisma.channelConnection.update({
      where: { id },
      data: {
        lastTestedAt: new Date(),
        lastTestStatus: status,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage
      }
    });
  }

  private async requireActiveAgent(organizationId: string, pluginInstallationId: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginInstallationId, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("AGENT_NOT_FOUND");
    if (plugin.status !== PluginStatus.ACTIVE) throw new ConflictException("AGENT_NOT_ACTIVE");
    return plugin;
  }

  private async requireChannel(organizationId: string, id: string) {
    const channel = await this.prisma.channelConnection.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { pluginInstallation: { select: { id: true, displayName: true, status: true } } }
    });
    if (!channel) throw new NotFoundException("CHANNEL_NOT_FOUND");
    return channel;
  }

  private sanitize(channel: ChannelConnectionRow) {
    const configuration = (channel.configuration ?? {}) as StoredConfiguration;
    const secretKeys = Object.keys(this.secretMetadataOf(channel));
    return {
      id: channel.id,
      name: channel.name,
      provider: channel.provider,
      channelType: channel.channelType,
      status: channel.status,
      agentId: channel.pluginInstallationId,
      agent: channel.pluginInstallation,
      configuration: { accountSid: configuration.accountSid, fromNumber: configuration.fromNumber },
      hasAuthToken: secretKeys.includes("authToken"),
      webhookUrl: this.webhookUrl(channel.id),
      lastTestedAt: channel.lastTestedAt,
      lastTestStatus: channel.lastTestStatus,
      lastErrorCode: channel.lastErrorCode,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    };
  }

  private secretMetadataOf(channel: ChannelConnectionRow): Record<string, unknown> {
    return typeof channel.secretMetadata === "object" && channel.secretMetadata !== null
      ? (channel.secretMetadata as Record<string, unknown>)
      : {};
  }

  private audit(
    organizationId: string,
    channelId: string,
    userId: string,
    requestId: string,
    event: string
  ) {
    this.auditLogger.record(event, requestId, { organizationId, userId, targetId: channelId });
  }
}

function secretMetadata(keys: readonly string[]) {
  const now = new Date().toISOString();
  return Object.fromEntries(keys.map((key) => [key, { configured: true, updatedAt: now }]));
}
function page<T>(items: T[], total: number, query: { page: number; pageSize: number }) {
  return {
    items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      pages: Math.ceil(total / query.pageSize)
    }
  };
}
function providerTestMessage(code: string): string {
  const messages: Record<string, string> = {
    CHANNEL_PROVIDER_AUTHENTICATION_FAILED: "Twilio rejected the configured Account SID or Auth Token.",
    CHANNEL_PROVIDER_RATE_LIMITED: "Twilio rate-limited the test request. Try again shortly.",
    CHANNEL_PROVIDER_UNAVAILABLE: "Twilio is currently unavailable.",
    CHANNEL_PROVIDER_TIMEOUT: "The request to Twilio timed out.",
    CHANNEL_PROVIDER_REJECTED: "Twilio rejected the test message.",
    CHANNEL_PROVIDER_RESPONSE_INVALID: "Twilio returned an unexpected response."
  };
  return messages[code] ?? "The channel connection test failed.";
}
