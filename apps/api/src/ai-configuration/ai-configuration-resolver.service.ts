import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AiProfilePurpose, AiModelProfile, AiProviderConnection } from "@prisma/client";
import type { AiProvider } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { FeatureFlagService } from "../feature-flags/feature-flag.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { AiProviderError, createAiProvider, type ProviderSettings } from "../plugins/plugin-ai.runtime";
import { SHARED_AI_CONFIGURATION_ENABLED } from "./ai-configuration.constants";
import type {
  AiConfigResolutionSource,
  ResolveAiConfigurationInput,
  ResolvedAiConfiguration
} from "./ai-configuration.types";

type ProfileWithConnection = AiModelProfile & { providerConnection: AiProviderConnection };

/**
 * The single read path for runtime AI configuration — every employee turn, skill execution,
 * embedding call, and scheduled/background AI job resolves its provider+model here instead of
 * reading PluginAiConfiguration (or any employee-specific config) directly. See PRECEDENCE below.
 *
 * Feature-flagged via SHARED_AI_CONFIGURATION_ENABLED (per-organization, via FeatureFlagService):
 * OFF -> behaves exactly as before this feature existed (legacy PluginAiConfiguration only).
 * ON  -> shared connections/profiles/assignments are consulted first, falling back to legacy
 *        config when nothing shared is configured yet, so existing organizations keep working
 *        even before their backfill has run.
 *
 * PRECEDENCE (purpose defaults to "DEFAULT" when the caller doesn't need a specific one):
 *   1. EmployeeAiProfileAssignment for (pluginInstallationId, purpose)      -> EMPLOYEE_PURPOSE_PROFILE
 *   2. EmployeeAiProfileAssignment for (pluginInstallationId, "DEFAULT")    -> EMPLOYEE_DEFAULT_PROFILE
 *   3. OrganizationAiDefaults' named field for this purpose (routing/reasoning/embedding), else
 *      any AiModelProfile flagged isDefault for this exact purpose           -> ORG_PURPOSE_DEFAULT
 *   4. OrganizationAiDefaults.defaultProfileId, else any AiModelProfile
 *      flagged isDefault for purpose "DEFAULT"                              -> ORG_DEFAULT
 *   5. Legacy PluginAiConfiguration for this plugin installation             -> LEGACY_PLUGIN_CONFIG
 *   6. Platform-managed default — not implemented anywhere in this codebase today (confirmed by
 *      audit); this step is a documented no-op, not a hidden fallback to some hardcoded model.
 *
 * `resolve()` returns safe, secret-free metadata only — fine to hand back to controllers/dashboard.
 * `resolveExecutable()` additionally decrypts the winning credential and builds a real AiProvider —
 * for execution-path callers only (AgentService/Receptionist/Skills/Knowledge), never a controller.
 */
@Injectable()
export class AiConfigurationResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService,
    private readonly featureFlags: FeatureFlagService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  async resolve(input: ResolveAiConfigurationInput): Promise<ResolvedAiConfiguration> {
    const { resolved } = await this.resolveInternal(input);
    return resolved;
  }

  /** Like `resolveExecutable`, but returns the raw decrypted credential instead of building a chat
   *  `AiProvider` — for execution paths that construct their own client because they aren't doing
   *  a chat completion (e.g. KnowledgeEmbeddingService's embeddings HTTP call). Internal
   *  execution-path use only; the credential this returns must never reach a controller/dashboard
   *  response. */
  async resolveCredential(
    input: ResolveAiConfigurationInput
  ): Promise<{ resolved: ResolvedAiConfiguration; apiKey?: string }> {
    return this.resolveInternal(input);
  }

  /** Decrypts the winning credential and builds a ready-to-call AiProvider. Only ever call this
   *  from an execution path (agent turn, skill run, embedding call) — never to answer an API/
   *  dashboard request, which must use `resolve()` instead. */
  async resolveExecutable(
    input: ResolveAiConfigurationInput
  ): Promise<{ provider: AiProvider; resolved: ResolvedAiConfiguration }> {
    const { resolved, apiKey } = await this.resolveInternal(input);
    this.assertProviderAllowed(resolved.providerType);
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
    return { provider: createAiProvider(settings, apiKey), resolved };
  }

  private async resolveInternal(
    input: ResolveAiConfigurationInput
  ): Promise<{ resolved: ResolvedAiConfiguration; apiKey?: string }> {
    const purpose: AiProfilePurpose = input.purpose ?? "DEFAULT";
    const flagOn = await this.featureFlags.isEnabled(
      SHARED_AI_CONFIGURATION_ENABLED,
      input.organizationId
    );

    if (flagOn) {
      const employeePurpose = await this.findEmployeeAssignment(
        input.organizationId,
        input.pluginInstallationId,
        purpose
      );
      if (employeePurpose) return this.fromProfile(employeePurpose, "EMPLOYEE_PURPOSE_PROFILE");

      if (purpose !== "DEFAULT") {
        const employeeDefault = await this.findEmployeeAssignment(
          input.organizationId,
          input.pluginInstallationId,
          "DEFAULT"
        );
        if (employeeDefault) return this.fromProfile(employeeDefault, "EMPLOYEE_DEFAULT_PROFILE");
      }

      const orgDefaults = await this.prisma.organizationAiDefaults.findUnique({
        where: { organizationId: input.organizationId }
      });

      const orgPurposeProfile = await this.findOrgPurposeDefault(
        input.organizationId,
        purpose,
        orgDefaults
      );
      if (orgPurposeProfile) return this.fromProfile(orgPurposeProfile, "ORG_PURPOSE_DEFAULT");

      // Always attempted, even when `purpose` is itself "DEFAULT" — orgDefaults.defaultProfileId
      // is a distinct pointer from "a profile flagged isDefault for purpose DEFAULT" (step 3's
      // generic fallback), so it must not be skipped just because step 3 already looked at the
      // same purpose value. An org that only set its single "Organization Default" profile (never
      // flagged any individual profile's own isDefault) must still resolve through this step.
      const orgDefaultProfile = await this.findOrgDefault(input.organizationId, orgDefaults);
      if (orgDefaultProfile) return this.fromProfile(orgDefaultProfile, "ORG_DEFAULT");
    }

    const legacy = await this.fromLegacyConfig(input.organizationId, input.pluginInstallationId);
    if (legacy) return legacy;

    // Step 6 (platform-managed default) is intentionally a no-op — no such mechanism exists in
    // this codebase. Throwing the exact same BadRequestException("AI_PROVIDER_NOT_CONFIGURED")
    // PluginAiService.resolveProvider already throws means every existing caller that catches and
    // falls back on this specific error (AgentService's Travel/employee-domain branches, the LLM
    // knowledge fallback) keeps working unchanged.
    throw new BadRequestException("AI_PROVIDER_NOT_CONFIGURED");
  }

  private async findEmployeeAssignment(
    organizationId: string,
    pluginInstallationId: string,
    purpose: AiProfilePurpose
  ): Promise<ProfileWithConnection | null> {
    const assignment = await this.prisma.employeeAiProfileAssignment.findUnique({
      where: { organizationId_pluginInstallationId_purpose: { organizationId, pluginInstallationId, purpose } },
      include: { modelProfile: { include: { providerConnection: true } } }
    });
    return activeProfile(assignment?.modelProfile ?? null);
  }

  private async findOrgPurposeDefault(
    organizationId: string,
    purpose: AiProfilePurpose,
    orgDefaults: { routingProfileId: string | null; reasoningProfileId: string | null; embeddingProfileId: string | null } | null
  ): Promise<ProfileWithConnection | null> {
    const namedId =
      purpose === "ROUTING"
        ? orgDefaults?.routingProfileId
        : purpose === "REASONING"
          ? orgDefaults?.reasoningProfileId
          : purpose === "EMBEDDING"
            ? orgDefaults?.embeddingProfileId
            : null;
    if (namedId) {
      const profile = await this.prisma.aiModelProfile.findFirst({
        where: { id: namedId, organizationId, isActive: true },
        include: { providerConnection: true }
      });
      if (profile) return profile;
    }
    // For purpose "DEFAULT" this exact isDefault+purpose query is also `findOrgDefault`'s own
    // fallback (step 4) — skip it here so that step doesn't run it twice.
    if (purpose === "DEFAULT") return null;
    const byFlag = await this.prisma.aiModelProfile.findFirst({
      where: { organizationId, purpose, isDefault: true, isActive: true },
      include: { providerConnection: true },
      orderBy: { updatedAt: "desc" }
    });
    return byFlag;
  }

  private async findOrgDefault(
    organizationId: string,
    orgDefaults: { defaultProfileId: string | null } | null
  ): Promise<ProfileWithConnection | null> {
    if (orgDefaults?.defaultProfileId) {
      const profile = await this.prisma.aiModelProfile.findFirst({
        where: { id: orgDefaults.defaultProfileId, organizationId, isActive: true },
        include: { providerConnection: true }
      });
      if (profile) return profile;
    }
    return this.prisma.aiModelProfile.findFirst({
      where: { organizationId, purpose: "DEFAULT", isDefault: true, isActive: true },
      include: { providerConnection: true },
      orderBy: { updatedAt: "desc" }
    });
  }

  private fromProfile(
    profile: ProfileWithConnection,
    source: AiConfigResolutionSource
  ): { resolved: ResolvedAiConfiguration; apiKey?: string } {
    const connection = profile.providerConnection;
    const isAzure = connection.providerType === "AZURE_OPENAI";
    const connMeta = (connection.metadataJson ?? {}) as Record<string, unknown>;
    const resolved: ResolvedAiConfiguration = {
      providerConnectionId: connection.id,
      modelProfileId: profile.id,
      providerType: connection.providerType,
      baseUrl: !isAzure ? connection.baseUrl : null,
      endpoint: isAzure ? connection.baseUrl : null,
      deploymentName: isAzure ? profile.model : null,
      apiVersion: isAzure && typeof connMeta.apiVersion === "string" ? connMeta.apiVersion : null,
      model: !isAzure ? profile.model : null,
      embeddingModel: !isAzure ? profile.embeddingModel : null,
      embeddingDeployment: isAzure ? profile.embeddingModel : null,
      temperature: profile.temperature !== null ? Number(profile.temperature) : null,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs ?? 30000,
      additionalSettings: (profile.additionalSettingsJson ?? {}) as Record<string, unknown>,
      credentialReference: connection.id,
      resolutionSource: source
    };
    if (connection.providerType === "DETERMINISTIC") return { resolved };
    const secrets = this.decrypt(connection.encryptedCredentialJson);
    return { resolved, ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}) };
  }

  private async fromLegacyConfig(
    organizationId: string,
    pluginInstallationId: string
  ): Promise<{ resolved: ResolvedAiConfiguration; apiKey?: string } | null> {
    const stored = await this.prisma.pluginAiConfiguration.findUnique({
      where: { pluginInstallationId }
    });
    if (!stored || stored.organizationId !== organizationId) return null;
    const cfg = (stored.configuration ?? {}) as Record<string, unknown>;
    const str = (key: string) => (typeof cfg[key] === "string" ? (cfg[key] as string) : null);
    const num = (key: string) => (typeof cfg[key] === "number" ? (cfg[key] as number) : null);
    const resolved: ResolvedAiConfiguration = {
      providerConnectionId: null,
      modelProfileId: null,
      providerType: stored.providerType,
      baseUrl: str("baseUrl"),
      endpoint: str("endpoint"),
      deploymentName: str("deploymentName"),
      apiVersion: str("apiVersion"),
      model: str("model"),
      embeddingModel: str("embeddingModel"),
      embeddingDeployment: str("embeddingDeployment"),
      temperature: null,
      maxOutputTokens: null,
      timeoutMs: num("timeoutMs") ?? 30000,
      additionalSettings: {},
      credentialReference: `legacy:${pluginInstallationId}`,
      resolutionSource: "LEGACY_PLUGIN_CONFIG"
    };
    if (stored.providerType === "DETERMINISTIC") return { resolved };
    const secrets = this.decrypt(stored.encryptedSecrets);
    return { resolved, ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}) };
  }

  private decrypt(payload: unknown): Record<string, string> {
    try {
      return this.encryption.decrypt(payload as EncryptedPayload);
    } catch {
      throw new AiProviderError("AI_PROVIDER_AUTHENTICATION_FAILED");
    }
  }

  private assertProviderAllowed(type: ResolvedAiConfiguration["providerType"]) {
    if (type === "DETERMINISTIC" && !this.security.allowDevelopmentImplementations)
      throw new AiProviderError("AI_PROVIDER_AUTHENTICATION_FAILED");
  }
}

function activeProfile(profile: ProfileWithConnection | null): ProfileWithConnection | null {
  return profile && profile.isActive ? profile : null;
}
