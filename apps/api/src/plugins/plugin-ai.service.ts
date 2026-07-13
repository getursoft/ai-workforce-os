import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PluginAiProviderType, PluginStatus, Prisma } from "@prisma/client";
import type { AiMessage, AiToolDefinition } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { PluginChatDto, UpdatePluginAiConfigurationDto } from "./plugin.dto";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "./plugin.runtime";
import { createAiProvider, SafeHttpTool, type ProviderSettings } from "./plugin-ai.runtime";

type StoredSettings = Omit<ProviderSettings, "providerType">;

@Injectable()
export class PluginAiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService,
    private readonly http: SafeHttpTool
  ) {}

  async get(organizationId: string, pluginId: string) {
    await this.plugin(organizationId, pluginId);
    const stored = await this.prisma.pluginAiConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    if (!stored)
      return {
        pluginInstallationId: pluginId,
        configured: false,
        providerType: null,
        configuration: {},
        secrets: { apiKey: { configured: false, updatedAt: null } },
        updatedAt: null
      };
    return {
      pluginInstallationId: pluginId,
      configured: true,
      providerType: stored.providerType,
      configuration: stored.configuration,
      secrets: {
        apiKey: {
          configured: this.secretKeys(stored.encryptedSecrets).includes("apiKey"),
          updatedAt: stored.updatedAt
        }
      },
      updatedAt: stored.updatedAt
    };
  }

  async update(
    organizationId: string,
    userId: string,
    pluginId: string,
    dto: UpdatePluginAiConfigurationDto
  ) {
    await this.plugin(organizationId, pluginId);
    const existing = await this.prisma.pluginAiConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    const oldSettings = (existing?.configuration ?? {}) as StoredSettings;
    const providerType =
      dto.providerType ?? existing?.providerType ?? PluginAiProviderType.DETERMINISTIC;
    const settings: StoredSettings = {
      ...oldSettings,
      timeoutMs: dto.timeoutMs ?? oldSettings.timeoutMs ?? 30000
    };
    for (const key of ["model", "baseUrl", "endpoint", "deploymentName", "apiVersion"] as const)
      if (dto[key] !== undefined) settings[key] = dto[key];
    this.validate(providerType, settings);
    const secrets = existing
      ? this.encryption.decrypt(existing.encryptedSecrets as unknown as EncryptedPayload)
      : {};
    if (dto.secrets?.apiKey?.trim()) secrets.apiKey = dto.secrets.apiKey.trim();
    for (const key of dto.removeSecrets ?? []) {
      if (key !== "apiKey") throw new BadRequestException("AI_SECRET_INVALID");
      delete secrets.apiKey;
    }
    const encrypted = this.encryption.encrypt(secrets);
    await this.prisma.pluginAiConfiguration.upsert({
      where: { pluginInstallationId: pluginId },
      create: {
        organizationId,
        pluginInstallationId: pluginId,
        providerType,
        configuration: settings as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encrypted as unknown as Prisma.InputJsonValue,
        updatedBy: userId
      },
      update: {
        providerType,
        configuration: settings as unknown as Prisma.InputJsonValue,
        encryptedSecrets: encrypted as unknown as Prisma.InputJsonValue,
        updatedBy: userId
      }
    });
    return this.get(organizationId, pluginId);
  }

  async test(organizationId: string, pluginId: string) {
    const { provider, settings } = await this.provider(organizationId, pluginId);
    const result = await provider.complete({
      messages: [{ role: "user", content: "Reply with OK." }],
      maxOutputTokens: 8
    });
    return {
      success: true,
      provider: result.provider,
      model: result.model,
      configuredProvider: settings.providerType
    };
  }

  async chat(organizationId: string, pluginId: string, dto: PluginChatDto) {
    const plugin = await this.plugin(organizationId, pluginId);
    if (plugin.status !== PluginStatus.ACTIVE) throw new BadRequestException("PLUGIN_DISABLED");
    const grants = Array.isArray(plugin.grantedPermissions)
      ? plugin.grantedPermissions.filter((x): x is string => typeof x === "string")
      : [];
    if (!grants.includes("LLM")) throw new BadRequestException("TOOL_CAPABILITY_NOT_GRANTED");
    const { provider } = await this.provider(organizationId, pluginId);
    const tools: AiToolDefinition[] = grants.includes("platform.http.request")
      ? [
          {
            name: "platform.http.request",
            description: "Fetch approved public travel information using GET or POST.",
            inputSchema: {
              type: "object",
              properties: { method: { enum: ["GET", "POST"] }, url: { type: "string" }, body: {} },
              required: ["method", "url"],
              additionalProperties: false
            }
          }
        ]
      : [];
    const messages: AiMessage[] = [
      {
        role: "system",
        content:
          "You are a travel planning assistant inside AI Workforce OS. Never claim a booking occurred. Clearly label unverified prices and availability. Never request payment-card details."
      },
      ...(dto.conversation ?? []).slice(-20),
      { role: "user", content: dto.message }
    ];
    const executions: Array<{ tool: string; status: string; durationMs: number }> = [];
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (let round = 0; round < 3; round++) {
      const result = await provider.complete({ messages, tools, maxOutputTokens: 1000 });
      usage = {
        inputTokens: usage.inputTokens + (result.usage?.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (result.usage?.outputTokens ?? 0),
        totalTokens: usage.totalTokens + (result.usage?.totalTokens ?? 0)
      };
      if (!result.toolCalls.length)
        return {
          message: result.content,
          provider: result.provider,
          model: result.model,
          toolExecutions: executions,
          usage
        };
      if (result.toolCalls.length > 5) throw new BadRequestException("AI_EXECUTION_LIMIT_REACHED");
      messages.push({ role: "assistant", content: result.content });
      for (const call of result.toolCalls) {
        if (call.name !== "platform.http.request" || !grants.includes(call.name))
          throw new BadRequestException("TOOL_CAPABILITY_NOT_GRANTED");
        const started = Date.now();
        try {
          const output = await this.http.execute(
            call.arguments as unknown as Parameters<SafeHttpTool["execute"]>[0]
          );
          executions.push({
            tool: call.name,
            status: "SUCCEEDED",
            durationMs: Date.now() - started
          });
          messages.push({
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: JSON.stringify(output).slice(0, 32000)
          });
        } catch {
          executions.push({ tool: call.name, status: "FAILED", durationMs: Date.now() - started });
          throw new BadRequestException("TOOL_EXECUTION_FAILED");
        }
      }
    }
    throw new BadRequestException("AI_EXECUTION_LIMIT_REACHED");
  }

  private async provider(organizationId: string, pluginId: string) {
    await this.plugin(organizationId, pluginId);
    const stored = await this.prisma.pluginAiConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    if (!stored) throw new BadRequestException("AI_PROVIDER_NOT_CONFIGURED");
    const settings = {
      providerType: stored.providerType,
      ...((stored.configuration ?? {}) as StoredSettings)
    } as ProviderSettings;
    const secrets = this.encryption.decrypt(stored.encryptedSecrets as unknown as EncryptedPayload);
    return { provider: createAiProvider(settings, secrets.apiKey), settings };
  }
  private async plugin(organizationId: string, id: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException("PLUGIN_NOT_FOUND");
    return plugin;
  }
  private validate(type: PluginAiProviderType, settings: StoredSettings) {
    if (type === "OPENAI_COMPATIBLE" && !settings.model?.trim())
      throw new BadRequestException("AI_PROVIDER_CONFIGURATION_INVALID");
    if (
      type === "AZURE_OPENAI" &&
      (!settings.endpoint?.trim() ||
        !settings.deploymentName?.trim() ||
        !settings.apiVersion?.trim())
    )
      throw new BadRequestException("AI_PROVIDER_CONFIGURATION_INVALID");
  }
  private secretKeys(value: unknown) {
    try {
      return Object.keys(this.encryption.decrypt(value as EncryptedPayload));
    } catch {
      return [];
    }
  }
}
