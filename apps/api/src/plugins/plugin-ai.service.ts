import { BadRequestException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { AiProfilePurpose, PluginAiProviderType, PluginStatus, Prisma } from "@prisma/client";
import type { AiMessage, AiToolDefinition } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import type { PluginChatDto, UpdatePluginAiConfigurationDto } from "./plugin.dto";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "./plugin.runtime";
import {
  AiProviderError,
  createAiProvider,
  SafeHttpTool,
  type ProviderSettings
} from "./plugin-ai.runtime";
import { AiConfigurationResolverService } from "../ai-configuration/ai-configuration-resolver.service";

type StoredSettings = Omit<ProviderSettings, "providerType">;

@Injectable()
export class PluginAiService {
  private readonly logger = new Logger(PluginAiService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService,
    private readonly http: SafeHttpTool,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Optional() private readonly aiConfigResolver?: AiConfigurationResolverService
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
    try {
      return await this.persistUpdate(organizationId, userId, pluginId, dto);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2021" || error.code === "P2022")
      )
        throw new IdentityApplicationError(
          "DATABASE_SCHEMA_OUT_OF_DATE",
          "The database schema is not ready for plugin AI configuration."
        );
      throw error;
    }
  }

  private async persistUpdate(
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
    this.assertProviderAllowed(providerType);
    const settings: StoredSettings = {
      ...oldSettings,
      timeoutMs: dto.timeoutMs ?? oldSettings.timeoutMs ?? 30000
    };
    for (const key of [
      "model",
      "embeddingModel",
      "baseUrl",
      "endpoint",
      "deploymentName",
      "embeddingDeployment",
      "apiVersion"
    ] as const)
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
    let providerType = "UNKNOWN";
    try {
      const { provider, settings } = await this.resolveProvider(organizationId, pluginId);
      providerType = settings.providerType;
      this.logger.log({ event: "AI_PROVIDER_TEST_STARTED", providerType, pluginId });
      const result = await provider.complete({
        messages: [{ role: "user", content: "Reply with OK." }],
        maxOutputTokens: 8
      });
      this.logger.log({ event: "AI_PROVIDER_TEST_SUCCEEDED", providerType, pluginId });
      return {
        success: true,
        provider: result.provider,
        model: result.model,
        configuredProvider: settings.providerType
      };
    } catch (error) {
      const mapped =
        error instanceof AiProviderError ? error : new AiProviderError("AI_PROVIDER_TEST_FAILED");
      this.logger.warn({
        event: "AI_PROVIDER_TEST_FAILED",
        providerType,
        pluginId,
        category: mapped.code,
        ...(mapped.upstreamStatus ? { upstreamStatus: mapped.upstreamStatus } : {})
      });
      throw new IdentityApplicationError(mapped.code, providerTestMessage(mapped.code));
    }
  }

  async chat(organizationId: string, pluginId: string, dto: PluginChatDto) {
    const plugin = await this.plugin(organizationId, pluginId);
    if (plugin.status !== PluginStatus.ACTIVE) throw new BadRequestException("PLUGIN_DISABLED");
    const grants = Array.isArray(plugin.grantedPermissions)
      ? plugin.grantedPermissions.filter((x): x is string => typeof x === "string")
      : [];
    if (!grants.includes("LLM")) throw new BadRequestException("TOOL_CAPABILITY_NOT_GRANTED");
    const { provider } = await this.resolveProvider(organizationId, pluginId);
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
          "You are a travel planning assistant inside Krevia.ai. Never claim a booking occurred. Clearly label unverified prices and availability. Never request payment-card details."
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

  /** The single call site every AI execution path (AgentService, Receptionist, Skills, embeddings)
   *  goes through to get a ready-to-call provider. When AiConfigurationResolverService is injected
   *  (always true in real DI — see PluginModule/AiConfigurationModule; only absent for isolated
   *  unit construction), it becomes the source of truth: shared connections/profiles/assignments
   *  first, falling back to this plugin's own legacy PluginAiConfiguration automatically (see
   *  AiConfigurationResolverService's precedence). `purpose` lets a caller ask for something more
   *  specific than the employee's DEFAULT profile (e.g. Receptionist asking for ROUTING). */
  async resolveProvider(organizationId: string, pluginId: string, purpose?: AiProfilePurpose) {
    await this.plugin(organizationId, pluginId);
    if (this.aiConfigResolver) {
      const { provider, resolved } = await this.aiConfigResolver.resolveExecutable({
        organizationId,
        pluginInstallationId: pluginId,
        ...(purpose ? { purpose } : {})
      });
      const settings: ProviderSettings = {
        providerType: resolved.providerType,
        timeoutMs: resolved.timeoutMs,
        ...(resolved.model ? { model: resolved.model } : {}),
        ...(resolved.embeddingModel ? { embeddingModel: resolved.embeddingModel } : {}),
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
        ...(resolved.deploymentName ? { deploymentName: resolved.deploymentName } : {}),
        ...(resolved.embeddingDeployment ? { embeddingDeployment: resolved.embeddingDeployment } : {}),
        ...(resolved.apiVersion ? { apiVersion: resolved.apiVersion } : {})
      };
      return {
        provider,
        settings,
        resolutionSource: resolved.resolutionSource,
        providerConnectionId: resolved.providerConnectionId,
        modelProfileId: resolved.modelProfileId
      };
    }
    const stored = await this.prisma.pluginAiConfiguration.findUnique({
      where: { pluginInstallationId: pluginId }
    });
    if (!stored) throw new BadRequestException("AI_PROVIDER_NOT_CONFIGURED");
    const settings = {
      providerType: stored.providerType,
      ...((stored.configuration ?? {}) as StoredSettings)
    } as ProviderSettings;
    this.assertProviderAllowed(settings.providerType);
    const secrets = this.encryption.decrypt(stored.encryptedSecrets as unknown as EncryptedPayload);
    return { provider: createAiProvider(settings, secrets.apiKey), settings };
  }
  private async plugin(organizationId: string, id: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!plugin)
      throw new IdentityApplicationError("PLUGIN_NOT_FOUND", "Plugin installation was not found.");
    return plugin;
  }
  private validate(type: PluginAiProviderType, settings: StoredSettings) {
    if (type === "OPENAI_COMPATIBLE" && !settings.model?.trim())
      throw new IdentityApplicationError(
        "AI_PROVIDER_CONFIGURATION_INVALID",
        "The AI provider configuration is invalid."
      );
    if (
      type === "AZURE_OPENAI" &&
      (!settings.endpoint?.trim() ||
        !settings.deploymentName?.trim() ||
        !settings.apiVersion?.trim())
    )
      throw new IdentityApplicationError(
        "AI_PROVIDER_CONFIGURATION_INVALID",
        "The AI provider configuration is invalid."
      );
  }
  private assertProviderAllowed(type: PluginAiProviderType | ProviderSettings["providerType"]) {
    if (type === "DETERMINISTIC" && !this.security.allowDevelopmentImplementations)
      throw new IdentityApplicationError(
        "DEVELOPMENT_PROVIDER_NOT_ALLOWED",
        "Development AI providers are not allowed in this environment."
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

function providerTestMessage(code: AiProviderError["code"]): string {
  const messages: Record<AiProviderError["code"], string> = {
    AI_PROVIDER_AUTHENTICATION_FAILED: "The AI provider rejected the configured credentials.",
    AI_PROVIDER_MODEL_NOT_FOUND: "The configured AI model or deployment was not found.",
    AI_PROVIDER_QUOTA_EXCEEDED: "The AI provider quota has been exceeded.",
    AI_PROVIDER_UNAVAILABLE: "The AI provider is currently unavailable.",
    AI_PROVIDER_TEST_FAILED: "The AI provider connection test failed.",
    AI_PROVIDER_RESPONSE_INVALID: "The AI provider returned an invalid response."
  };
  return messages[code];
}
