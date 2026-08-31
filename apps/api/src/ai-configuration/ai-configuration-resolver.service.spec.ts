import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { SecurityConfig } from "../identity/infrastructure/security/security-config";
import { PluginSecretsEncryptionService } from "../plugins/plugin.runtime";
import { AiConfigurationResolverService } from "./ai-configuration-resolver.service";

const key = Buffer.alloc(32, 9);
const developmentSecurity = { allowDevelopmentImplementations: true } as SecurityConfig;
const productionSecurity = { allowDevelopmentImplementations: false } as SecurityConfig;

interface Fixture {
  connections: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
  orgDefaults: Record<string, unknown> | null;
  legacyConfigs: Array<Record<string, unknown>>;
}

function encryptedApiKey(encryption: PluginSecretsEncryptionService, apiKey: string) {
  return encryption.encrypt({ apiKey }) as unknown;
}

function harness(fixture: Fixture, flagEnabled: boolean, security: SecurityConfig = developmentSecurity) {
  const encryption = new PluginSecretsEncryptionService(key);

  const prisma = {
    employeeAiProfileAssignment: {
      findUnique: vi.fn(async ({ where }: { where: { organizationId_pluginInstallationId_purpose: { organizationId: string; pluginInstallationId: string; purpose: string } } }) => {
        const w = where.organizationId_pluginInstallationId_purpose;
        const assignment = fixture.assignments.find(
          (a) =>
            a.organizationId === w.organizationId &&
            a.pluginInstallationId === w.pluginInstallationId &&
            a.purpose === w.purpose
        );
        if (!assignment) return null;
        const profile = fixture.profiles.find((p) => p.id === assignment.modelProfileId);
        return profile
          ? { ...assignment, modelProfile: { ...profile, providerConnection: fixture.connections.find((c) => c.id === profile.providerConnectionId) } }
          : null;
      })
    },
    organizationAiDefaults: {
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        fixture.orgDefaults && fixture.orgDefaults.organizationId === where.organizationId
          ? fixture.orgDefaults
          : null
      )
    },
    aiModelProfile: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const match = fixture.profiles.find((p) => {
          if (where.id && p.id !== where.id) return false;
          if (where.organizationId && p.organizationId !== where.organizationId) return false;
          if (where.purpose && p.purpose !== where.purpose) return false;
          if (where.isDefault !== undefined && p.isDefault !== where.isDefault) return false;
          if (where.isActive !== undefined && p.isActive !== where.isActive) return false;
          return true;
        });
        return match ? { ...match, providerConnection: fixture.connections.find((c) => c.id === match.providerConnectionId) } : null;
      })
    },
    pluginAiConfiguration: {
      findUnique: vi.fn(async ({ where }: { where: { pluginInstallationId: string } }) =>
        fixture.legacyConfigs.find((c) => c.pluginInstallationId === where.pluginInstallationId) ?? null
      )
    }
  } as unknown as PrismaService;

  const featureFlags = { isEnabled: vi.fn().mockResolvedValue(flagEnabled) };

  const resolver = new AiConfigurationResolverService(
    prisma,
    encryption,
    featureFlags as never,
    security
  );
  return { resolver, prisma, encryption, featureFlags };
}

describe("AiConfigurationResolverService precedence", () => {
  it("uses the employee purpose-specific assignment first", async () => {
    const { resolver, encryption } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk-conn") }],
        profiles: [
          { id: "profile-routing", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "ROUTING", model: "gpt-4.1-mini", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 15000, additionalSettingsJson: {}, isActive: true },
          { id: "profile-default", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "gpt-4.1", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }
        ],
        assignments: [
          { organizationId: "org-1", pluginInstallationId: "receptionist-1", modelProfileId: "profile-routing", purpose: "ROUTING" },
          { organizationId: "org-1", pluginInstallationId: "receptionist-1", modelProfileId: "profile-default", purpose: "DEFAULT" }
        ],
        orgDefaults: null,
        legacyConfigs: []
      },
      true
    );
    void encryption;
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      pluginInstallationId: "receptionist-1",
      purpose: "ROUTING"
    });
    expect(resolved.resolutionSource).toBe("EMPLOYEE_PURPOSE_PROFILE");
    expect(resolved.model).toBe("gpt-4.1-mini");
    expect(resolved.modelProfileId).toBe("profile-routing");
  });

  it("falls back to the employee DEFAULT assignment when no purpose-specific one exists", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk-conn") }],
        profiles: [{ id: "profile-default", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "gpt-4.1", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }],
        assignments: [{ organizationId: "org-1", pluginInstallationId: "travel-1", modelProfileId: "profile-default", purpose: "DEFAULT" }],
        orgDefaults: null,
        legacyConfigs: []
      },
      true
    );
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      pluginInstallationId: "travel-1",
      purpose: "CONVERSATION"
    });
    expect(resolved.resolutionSource).toBe("EMPLOYEE_DEFAULT_PROFILE");
    expect(resolved.model).toBe("gpt-4.1");
  });

  it("falls back to the organization purpose-specific default (named OrganizationAiDefaults field)", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk") }],
        profiles: [{ id: "profile-router", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "ROUTING", model: "fast-model", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 15000, additionalSettingsJson: {}, isActive: true }],
        assignments: [],
        orgDefaults: { organizationId: "org-1", defaultProfileId: null, routingProfileId: "profile-router", reasoningProfileId: null, embeddingProfileId: null },
        legacyConfigs: []
      },
      true
    );
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      pluginInstallationId: "receptionist-1",
      purpose: "ROUTING"
    });
    expect(resolved.resolutionSource).toBe("ORG_PURPOSE_DEFAULT");
    expect(resolved.model).toBe("fast-model");
  });

  it("falls back to a profile flagged isDefault for the exact purpose when no named OrganizationAiDefaults field covers it", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk") }],
        profiles: [{ id: "profile-summary", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "SUMMARIZATION", model: "summary-model", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 15000, additionalSettingsJson: {}, isDefault: true, isActive: true }],
        assignments: [],
        orgDefaults: null,
        legacyConfigs: []
      },
      true
    );
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      pluginInstallationId: "some-skill-employee",
      purpose: "SUMMARIZATION"
    });
    expect(resolved.resolutionSource).toBe("ORG_PURPOSE_DEFAULT");
    expect(resolved.model).toBe("summary-model");
  });

  it("falls back to the organization default when no purpose-specific default exists", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk") }],
        profiles: [{ id: "profile-standard", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "gpt-4.1", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }],
        assignments: [],
        orgDefaults: { organizationId: "org-1", defaultProfileId: "profile-standard", routingProfileId: null, reasoningProfileId: null, embeddingProfileId: null },
        legacyConfigs: []
      },
      true
    );
    const resolved = await resolver.resolve({
      organizationId: "org-1",
      pluginInstallationId: "hr-1",
      purpose: "REASONING"
    });
    expect(resolved.resolutionSource).toBe("ORG_DEFAULT");
    expect(resolved.model).toBe("gpt-4.1");
  });

  it("falls back to legacy PluginAiConfiguration when nothing shared is configured", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { resolver } = harness(
      {
        connections: [],
        profiles: [],
        assignments: [],
        orgDefaults: null,
        legacyConfigs: [
          {
            pluginInstallationId: "legacy-1",
            organizationId: "org-1",
            providerType: "OPENAI_COMPATIBLE",
            configuration: { model: "legacy-model", baseUrl: "https://api.example.test/v1", timeoutMs: 20000 },
            encryptedSecrets: encryption.encrypt({ apiKey: "legacy-key" })
          }
        ]
      },
      true
    );
    const resolved = await resolver.resolve({ organizationId: "org-1", pluginInstallationId: "legacy-1" });
    expect(resolved.resolutionSource).toBe("LEGACY_PLUGIN_CONFIG");
    expect(resolved.model).toBe("legacy-model");
  });

  it("throws AI_PROVIDER_NOT_CONFIGURED when nothing resolves at all", async () => {
    const { resolver } = harness({ connections: [], profiles: [], assignments: [], orgDefaults: null, legacyConfigs: [] }, true);
    await expect(
      resolver.resolve({ organizationId: "org-1", pluginInstallationId: "nobody" })
    ).rejects.toMatchObject({ message: "AI_PROVIDER_NOT_CONFIGURED" });
    await expect(
      resolver.resolve({ organizationId: "org-1", pluginInstallationId: "nobody" })
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("feature flag OFF skips shared config entirely and goes straight to legacy", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { resolver, prisma } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk") }],
        profiles: [{ id: "profile-default", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "shared-model", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }],
        assignments: [{ organizationId: "org-1", pluginInstallationId: "plugin-1", modelProfileId: "profile-default", purpose: "DEFAULT" }],
        orgDefaults: null,
        legacyConfigs: [
          {
            pluginInstallationId: "plugin-1",
            organizationId: "org-1",
            providerType: "OPENAI_COMPATIBLE",
            configuration: { model: "legacy-model", timeoutMs: 30000 },
            encryptedSecrets: encryption.encrypt({ apiKey: "legacy-key" })
          }
        ]
      },
      false // flag OFF
    );
    const resolved = await resolver.resolve({ organizationId: "org-1", pluginInstallationId: "plugin-1" });
    expect(resolved.resolutionSource).toBe("LEGACY_PLUGIN_CONFIG");
    expect(resolved.model).toBe("legacy-model");
    expect(prisma.employeeAiProfileAssignment.findUnique).not.toHaveBeenCalled();
  });

  it("resolveExecutable decrypts the shared connection's credential and builds a real provider", async () => {
    const encryption = new PluginSecretsEncryptionService(key);
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: "https://api.openai.com/v1", metadataJson: {}, encryptedCredentialJson: encryption.encrypt({ apiKey: "sk-real-secret" }) }],
        profiles: [{ id: "profile-default", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "gpt-4.1", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }],
        assignments: [{ organizationId: "org-1", pluginInstallationId: "plugin-1", modelProfileId: "profile-default", purpose: "DEFAULT" }],
        orgDefaults: null,
        legacyConfigs: []
      },
      true
    );
    const { provider, resolved } = await resolver.resolveExecutable({
      organizationId: "org-1",
      pluginInstallationId: "plugin-1"
    });
    expect(provider).toBeDefined();
    expect(resolved.model).toBe("gpt-4.1");
    // The credential itself must never appear on the safe resolved shape.
    expect(JSON.stringify(resolved)).not.toContain("sk-real-secret");
  });

  it("an inactive profile is treated as absent and falls through to the next precedence step", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "OPENAI_COMPATIBLE", baseUrl: null, metadataJson: {}, encryptedCredentialJson: encryptedApiKey(new PluginSecretsEncryptionService(key), "sk") }],
        profiles: [
          { id: "profile-inactive", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "disabled-model", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: false },
          { id: "profile-org-default", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: "org-model", embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }
        ],
        assignments: [{ organizationId: "org-1", pluginInstallationId: "plugin-1", modelProfileId: "profile-inactive", purpose: "DEFAULT" }],
        orgDefaults: { organizationId: "org-1", defaultProfileId: "profile-org-default", routingProfileId: null, reasoningProfileId: null, embeddingProfileId: null },
        legacyConfigs: []
      },
      true
    );
    const resolved = await resolver.resolve({ organizationId: "org-1", pluginInstallationId: "plugin-1" });
    expect(resolved.resolutionSource).toBe("ORG_DEFAULT");
    expect(resolved.model).toBe("org-model");
  });

  it("rejects a DETERMINISTIC resolution outside development", async () => {
    const { resolver } = harness(
      {
        connections: [{ id: "conn-1", providerType: "DETERMINISTIC", baseUrl: null, metadataJson: {}, encryptedCredentialJson: {} }],
        profiles: [{ id: "profile-det", organizationId: "org-1", providerConnectionId: "conn-1", purpose: "DEFAULT", model: null, embeddingModel: null, temperature: null, maxOutputTokens: null, timeoutMs: 30000, additionalSettingsJson: {}, isActive: true }],
        assignments: [{ organizationId: "org-1", pluginInstallationId: "plugin-1", modelProfileId: "profile-det", purpose: "DEFAULT" }],
        orgDefaults: null,
        legacyConfigs: []
      },
      true,
      productionSecurity
    );
    await expect(
      resolver.resolveExecutable({ organizationId: "org-1", pluginInstallationId: "plugin-1" })
    ).rejects.toMatchObject({ code: "AI_PROVIDER_AUTHENTICATION_FAILED" });
  });
});
