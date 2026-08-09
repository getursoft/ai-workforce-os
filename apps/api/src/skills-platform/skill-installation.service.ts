import { Injectable, Optional } from "@nestjs/common";
import { Ajv, type ValidateFunction } from "ajv";
import type { SkillManifest } from "@ai-workforce-os/skill-sdk";
import { isCompatibleUpgrade, resolveCompatibleVersion, versionSatisfies, installerOf } from "@ai-workforce-os/skill-sdk";
import { SENSITIVE_CAPABILITY_KEYS } from "@ai-workforce-os/skill-sdk";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EntitlementService } from "../entitlements/entitlement.service";
import { SkillRegistryService } from "./skill-registry.service";
import { SkillError } from "./skill-error";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

const CONFIGURATION_LIMIT = 16 * 1024;

export interface InstallSkillInput {
  skillKey: string;
  versionConstraint?: string;
  configuration?: Record<string, unknown>;
  enabled?: boolean;
  approveSensitivePermissions?: boolean;
}

@Injectable()
export class SkillInstallationService {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly schemaCache = new Map<string, ValidateFunction>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService,
    @Optional() private readonly entitlements?: EntitlementService,
    @Optional() private readonly audit?: AuditEventLogger
  ) {}

  // ------------------------------------------------------------------ marketplace / installs

  async marketplace(organizationId: string) {
    if (this.entitlements) await this.entitlements.assertFeature(organizationId, "SKILLS_MARKETPLACE");
    const installed = await this.prisma.skillInstallation.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true, skillVersion: { select: { skillId: true, version: true, skill: { select: { key: true } } } } }
    });
    const installedBySkill = new Map<string, string[]>();
    for (const row of installed) {
      const list = installedBySkill.get(row.skillVersion.skill.key) ?? [];
      list.push(row.skillVersion.version);
      installedBySkill.set(row.skillVersion.skill.key, list);
    }
    const skills = await this.prisma.skill.findMany({
      where: { deletedAt: null, isActive: true },
      include: {
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { version: "desc" }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    return {
      items: skills.map((skill) => ({
        id: skill.id,
        key: skill.key,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        author: skill.author,
        icon: skill.icon,
        visibility: skill.visibility,
        latestVersion: skill.latestVersion,
        versions: skill.versions.map((version) => version.version),
        installedVersions: installedBySkill.get(skill.key) ?? [],
        installed: (installedBySkill.get(skill.key) ?? []).length > 0
      }))
    };
  }

  async listInstallations(organizationId: string) {
    return this.prisma.skillInstallation.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        skillVersion: { include: { skill: true, dependencies: true } },
        _count: { select: { grants: true, executions: true } }
      },
      orderBy: { installedAt: "desc" }
    });
  }

  async getInstallation(organizationId: string, installationId: string) {
    const installation = await this.prisma.skillInstallation.findFirst({
      where: { id: installationId, organizationId, deletedAt: null },
      include: {
        skillVersion: { include: { skill: true, dependencies: true } },
        grants: { include: { pluginInstallation: { select: { id: true, displayName: true, slug: true } } } }
      }
    });
    if (!installation) throw new SkillError("SKILL_NOT_INSTALLED");
    return installation;
  }

  // ------------------------------------------------------------------ lifecycle

  async install(organizationId: string, userId: string, input: InstallSkillInput, requestId?: string) {
    if (this.entitlements) {
      await this.entitlements.assertFeature(organizationId, "SKILLS_INSTALL");
      await this.entitlements.consumeCapacity(organizationId, "SKILLS_MAX_INSTALLED");
    }

    const version = await this.resolvePublishedVersion(input.skillKey, input.versionConstraint);
    const manifest = readManifest(version.manifestJson);
    if (!manifest) throw new SkillError("SKILL_INTERNAL_ERROR");

    const existing = await this.prisma.skillInstallation.findFirst({
      where: { organizationId, skillVersionId: version.id, deletedAt: null }
    });
    if (existing) throw new SkillError("SKILL_ALREADY_INSTALLED");

    const configuration = await this.validateConfiguration(manifest, input.configuration ?? {});

    const sensitiveRequested = (manifest.requiredCapabilities ?? []).filter((capability) =>
      SENSITIVE_CAPABILITY_KEYS.has(capability)
    );
    if (sensitiveRequested.length > 0 && input.approveSensitivePermissions !== true) {
      throw new SkillError("SKILL_SENSITIVE_PERMISSION_REQUIRED");
    }

    await this.assertRequiredDependenciesInstalled(organizationId, manifest);

    if (manifest.billingCategory === "AI_PROVIDER_BACKED" && this.entitlements) {
      await this.entitlements.assertFeature(organizationId, "SKILLS_AI_BACKED");
    }
    if (manifest.requiredCapabilities.includes("network.external") && this.entitlements) {
      await this.entitlements.assertFeature(organizationId, "SKILLS_EXTERNAL_NETWORK");
    }

    let installation;
    try {
      installation = await this.prisma.$transaction(async (tx) => {
        const created = await tx.skillInstallation.create({
          data: {
            organizationId,
            skillVersionId: version.id,
            status: input.enabled === true ? "ENABLED" : "INSTALLED",
            configurationJson: configuration as Prisma.InputJsonValue,
            installedByUserId: userId,
            enabled: input.enabled === true
          }
        });
        const adapter = this.registry.resolveByConstraint(manifest.key, manifest.version);
        const installer = adapter ? installerOf(adapter) : undefined;
        if (installer?.install) {
          await installer.install({
            organizationId,
            userId: userId ?? null,
            configuration,
            grantedPermissions: new Set(manifest.requiredPermissions),
            grantedCapabilities: new Set(manifest.requiredCapabilities),
            idempotencyKey: `install:${organizationId}:${manifest.key}:${manifest.version}`,
            capabilities: {}
          });
        }
        return created;
      });
    } catch (error) {
      this.audit?.record("SKILL_INSTALL_FAILED", requestId ?? "skill-install", {
        organizationId,
        userId,
        skillKey: manifest.key,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
      });
      throw error;
    }

    this.audit?.record("SKILL_INSTALLED", requestId ?? "skill-install", {
      organizationId,
      userId,
      skillKey: manifest.key,
      skillVersion: manifest.version,
      installationId: installation.id
    });
    return this.getInstallation(organizationId, installation.id);
  }

  async uninstall(organizationId: string, userId: string, installationId: string, requestId?: string) {
    const installation = await this.getInstallation(organizationId, installationId);
    await this.prisma.$transaction(async (tx) => {
      await tx.skillInstallation.updateMany({
        where: { id: installationId, organizationId },
        data: { deletedAt: new Date(), status: "UNINSTALLED", enabled: false }
      });
      const manifest = readManifest(installation.skillVersion.manifestJson);
      if (manifest) {
        const adapter = this.registry.resolveByConstraint(manifest.key, manifest.version);
        const installer = adapter ? installerOf(adapter) : undefined;
        if (installer?.uninstall) {
          await installer.uninstall({
            organizationId,
            userId: userId ?? null,
            configuration: readRecord(installation.configurationJson),
            grantedPermissions: new Set(manifest.requiredPermissions),
            grantedCapabilities: new Set(manifest.requiredCapabilities),
            idempotencyKey: `uninstall:${organizationId}:${manifest.key}:${manifest.version}`,
            capabilities: {}
          });
        }
      }
    });
    this.audit?.record("SKILL_UNINSTALLED", requestId ?? "skill-uninstall", {
      organizationId,
      userId,
      installationId
    });
    return { uninstalled: true, installationId };
  }

  async enable(organizationId: string, userId: string, installationId: string, requestId?: string) {
    const installation = await this.getInstallation(organizationId, installationId);
    const manifest = readManifest(installation.skillVersion.manifestJson);
    if (manifest && manifest.requiredCapabilities.includes("network.external") && this.entitlements) {
      await this.entitlements.assertFeature(organizationId, "SKILLS_EXTERNAL_NETWORK");
    }
    await this.prisma.skillInstallation.updateMany({
      where: { id: installationId, organizationId, deletedAt: null },
      data: { enabled: true, status: "ENABLED" }
    });
    if (manifest) {
      const adapter = this.registry.resolveByConstraint(manifest.key, manifest.version);
      const installer = adapter ? installerOf(adapter) : undefined;
      if (installer?.enable) {
        await installer.enable({
          organizationId,
          userId: userId ?? null,
          configuration: readRecord(installation.configurationJson),
          grantedPermissions: new Set(manifest.requiredPermissions),
          grantedCapabilities: new Set(manifest.requiredCapabilities),
          idempotencyKey: `enable:${organizationId}:${manifest.key}:${manifest.version}`,
          capabilities: {}
        });
      }
    }
    this.audit?.record("SKILL_ENABLED", requestId ?? "skill-enable", {
      organizationId,
      userId,
      installationId,
      skillKey: installation.skillVersion.skill.key
    });
    return this.getInstallation(organizationId, installationId);
  }

  async disable(organizationId: string, userId: string, installationId: string, requestId?: string) {
    const installation = await this.getInstallation(organizationId, installationId);
    await this.prisma.skillInstallation.updateMany({
      where: { id: installationId, organizationId, deletedAt: null },
      data: { enabled: false, status: "DISABLED" }
    });
    const manifest = readManifest(installation.skillVersion.manifestJson);
    if (manifest) {
      const adapter = this.registry.resolveByConstraint(manifest.key, manifest.version);
      const installer = adapter ? installerOf(adapter) : undefined;
      if (installer?.disable) {
        await installer.disable({
          organizationId,
          userId: userId ?? null,
          configuration: readRecord(installation.configurationJson),
          grantedPermissions: new Set(manifest.requiredPermissions),
          grantedCapabilities: new Set(manifest.requiredCapabilities),
          idempotencyKey: `disable:${organizationId}:${manifest.key}:${manifest.version}`,
          capabilities: {}
        });
      }
    }
    this.audit?.record("SKILL_DISABLED", requestId ?? "skill-disable", {
      organizationId,
      userId,
      installationId,
      skillKey: installation.skillVersion.skill.key
    });
    return this.getInstallation(organizationId, installationId);
  }

  async configure(
    organizationId: string,
    userId: string,
    installationId: string,
    configuration: Record<string, unknown>,
    requestId?: string
  ) {
    const installation = await this.getInstallation(organizationId, installationId);
    const manifest = readManifest(installation.skillVersion.manifestJson);
    if (!manifest) throw new SkillError("SKILL_INTERNAL_ERROR");
    const validated = await this.validateConfiguration(manifest, configuration);
    await this.prisma.skillInstallation.updateMany({
      where: { id: installationId, organizationId, deletedAt: null },
      data: { configurationJson: validated as Prisma.InputJsonValue }
    });
    this.audit?.record("SKILL_CONFIGURED", requestId ?? "skill-configure", {
      organizationId,
      userId,
      installationId,
      skillKey: manifest.key
    });
    return this.getInstallation(organizationId, installationId);
  }

  /** Upgrades an installation to a compatible (same-major by default) newer version, preserving
   *  configuration. The previous version id is retained so rollback() can restore it. */
  async updateVersion(
    organizationId: string,
    userId: string,
    installationId: string,
    versionConstraint: string,
    requestId?: string
  ) {
    const installation = await this.getInstallation(organizationId, installationId);
    const currentManifest = readManifest(installation.skillVersion.manifestJson);
    if (!currentManifest) throw new SkillError("SKILL_INTERNAL_ERROR");
    const target = await this.resolvePublishedVersion(currentManifest.key, versionConstraint);
    if (target.version === installation.skillVersion.version)
      throw new SkillError("SKILL_INSTALLATION_STATE_CONFLICT", "The installation is already on this version");
    if (!isCompatibleUpgrade(installation.skillVersion.version, target.version))
      throw new SkillError("SKILL_DEPENDENCY_VERSION_CONFLICT", "Incompatible major version; rollback not possible automatically");

    const targetManifest = readManifest(target.manifestJson);
    if (!targetManifest) throw new SkillError("SKILL_INTERNAL_ERROR");

    // Migrate configuration if the newer adapter provides a migration hook; otherwise preserve as-is.
    let configuration = readRecord(installation.configurationJson);
    const toAdapter = this.registry.resolveByConstraint(targetManifest.key, targetManifest.version);
    const installer = toAdapter ? installerOf(toAdapter) : undefined;
    if (installer?.migrate) {
      try {
        configuration = await installer.migrate(installation.skillVersion.version, target.version, configuration);
      } catch {
        throw new SkillError("SKILL_INVALID_CONFIGURATION", "Configuration migration failed");
      }
    }
    configuration = await this.validateConfiguration(targetManifest, configuration);
    const meta = readRecord(configuration._meta);
    meta.previousSkillVersionId = installation.skillVersionId;
    configuration = { ...configuration, _meta: meta };

    await this.prisma.skillInstallation.updateMany({
      where: { id: installationId, organizationId, deletedAt: null },
      data: {
        skillVersionId: target.id,
        configurationJson: configuration as Prisma.InputJsonValue
      }
    });
    this.audit?.record("SKILL_VERSION_UPDATED", requestId ?? "skill-update", {
      organizationId,
      userId,
      installationId,
      skillKey: currentManifest.key,
      fromVersion: installation.skillVersion.version,
      toVersion: target.version
    });
    return this.getInstallation(organizationId, installationId);
  }

  async rollbackVersion(organizationId: string, userId: string, installationId: string, requestId?: string) {
    const installation = await this.getInstallation(organizationId, installationId);
    const manifest = readManifest(installation.skillVersion.manifestJson);
    const configuration = readRecord(installation.configurationJson);
    const meta = readRecord(configuration._meta);
    const previousVersionId = meta.previousSkillVersionId;
    if (!previousVersionId || typeof previousVersionId !== "string")
      throw new SkillError("SKILL_INSTALLATION_STATE_CONFLICT", "No previous version to roll back to");

    const previous = await this.prisma.skillVersion.findFirst({
      where: { id: previousVersionId, skillId: installation.skillVersion.skillId, status: "PUBLISHED" }
    });
    if (!previous) throw new SkillError("SKILL_VERSION_NOT_FOUND");

    const nextConfiguration = { ...configuration };
    delete (nextConfiguration as Record<string, unknown>)._meta;

    await this.prisma.skillInstallation.updateMany({
      where: { id: installationId, organizationId, deletedAt: null },
      data: { skillVersionId: previous.id, configurationJson: nextConfiguration as Prisma.InputJsonValue }
    });
    this.audit?.record("SKILL_VERSION_ROLLED_BACK", requestId ?? "skill-rollback", {
      organizationId,
      userId,
      installationId,
      skillKey: manifest?.key ?? installation.skillVersion.skill.key,
      toVersion: previous.version
    });
    return this.getInstallation(organizationId, installationId);
  }

  // ------------------------------------------------------------------ employee grants

  async grantToEmployee(
    organizationId: string,
    userId: string,
    pluginInstallationId: string,
    skillInstallationId: string,
    configurationOverride?: Record<string, unknown>,
    requestId?: string
  ) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id: pluginInstallationId, organizationId, deletedAt: null }
    });
    if (!plugin) throw new SkillError("SKILL_EMPLOYEE_NOT_FOUND");
    const installation = await this.getInstallation(organizationId, skillInstallationId);

    if (this.entitlements) {
      const existingGrant = await this.prisma.employeeSkillGrant.findFirst({
        where: { organizationId, pluginInstallationId, skillInstallationId }
      });
      if (!existingGrant) {
        const [limit, used] = await Promise.all([
          this.entitlements.getLimit(organizationId, "SKILLS_MAX_PER_EMPLOYEE"),
          this.prisma.employeeSkillGrant.count({ where: { organizationId, pluginInstallationId } })
        ]);
        if (used + 1 > limit) throw new SkillError("SKILL_LIMIT_REACHED", "This employee has reached its plan limit for granted skills");
      }
    }

    const manifest = readManifest(installation.skillVersion.manifestJson);
    const configuration = configurationOverride ?? {};
    if (manifest) await this.validateConfiguration(manifest, configuration, true);

    await this.prisma.employeeSkillGrant.upsert({
      where: {
        organizationId_pluginInstallationId_skillInstallationId: {
          organizationId,
          pluginInstallationId,
          skillInstallationId
        }
      },
      create: {
        organizationId,
        pluginInstallationId,
        skillInstallationId,
        enabled: true,
        configurationOverrideJson: configuration as Prisma.InputJsonValue,
        grantedByUserId: userId
      },
      update: {
        enabled: true,
        configurationOverrideJson: configuration as Prisma.InputJsonValue,
        grantedByUserId: userId
      }
    });
    this.audit?.record("SKILL_GRANTED_TO_EMPLOYEE", requestId ?? "skill-grant", {
      organizationId,
      userId,
      employeeInstallationId: pluginInstallationId,
      skillInstallationId,
      skillKey: manifest?.key ?? installation.skillVersion.skill.key
    });
    return this.listGrantsForEmployee(organizationId, pluginInstallationId);
  }

  async revokeFromEmployee(
    organizationId: string,
    userId: string,
    pluginInstallationId: string,
    skillInstallationId: string,
    requestId?: string
  ) {
    const grant = await this.prisma.employeeSkillGrant.findFirst({
      where: { organizationId, pluginInstallationId, skillInstallationId }
    });
    if (!grant) throw new SkillError("SKILL_EMPLOYEE_GRANT_DENIED", "No grant exists for this employee");
    await this.prisma.employeeSkillGrant.delete({ where: { id: grant.id } });
    this.audit?.record("SKILL_REVOKED_FROM_EMPLOYEE", requestId ?? "skill-revoke", {
      organizationId,
      userId,
      employeeInstallationId: pluginInstallationId,
      skillInstallationId
    });
    return this.listGrantsForEmployee(organizationId, pluginInstallationId);
  }

  async setEmployeeGrantEnabled(
    organizationId: string,
    userId: string,
    pluginInstallationId: string,
    skillInstallationId: string,
    enabled: boolean,
    requestId?: string
  ) {
    const grant = await this.prisma.employeeSkillGrant.findFirst({
      where: { organizationId, pluginInstallationId, skillInstallationId }
    });
    if (!grant) throw new SkillError("SKILL_EMPLOYEE_GRANT_DENIED");
    await this.prisma.employeeSkillGrant.update({
      where: { id: grant.id },
      data: { enabled }
    });
    this.audit?.record(enabled ? "SKILL_GRANT_ENABLED" : "SKILL_GRANT_DISABLED", requestId ?? "skill-grant-state", {
      organizationId,
      userId,
      employeeInstallationId: pluginInstallationId,
      skillInstallationId
    });
    return this.listGrantsForEmployee(organizationId, pluginInstallationId);
  }

  async listGrantsForEmployee(organizationId: string, pluginInstallationId: string) {
    return this.prisma.employeeSkillGrant.findMany({
      where: { organizationId, pluginInstallationId },
      include: {
        skillInstallation: {
          include: { skillVersion: { include: { skill: true } } }
        }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  /** Grants for a skill installation across all employees (dashboard "supported employees"). */
  async listGrantsForSkillInstallation(organizationId: string, skillInstallationId: string) {
    return this.prisma.employeeSkillGrant.findMany({
      where: { organizationId, skillInstallationId },
      include: { pluginInstallation: { select: { id: true, displayName: true, slug: true } } },
      orderBy: { createdAt: "desc" }
    });
  }

  // ------------------------------------------------------------------ helpers

  private async resolvePublishedVersion(skillKey: string, versionConstraint?: string) {
    const versions = await this.prisma.skillVersion.findMany({
      where: { status: "PUBLISHED", skill: { key: skillKey, deletedAt: null } },
      orderBy: { version: "desc" }
    });
    if (versions.length === 0) throw new SkillError("SKILL_VERSION_NOT_FOUND");
    let match: (typeof versions)[number] | undefined;
    if (versionConstraint) {
      const exact = versions.find((version) => version.version === versionConstraint);
      if (exact) {
        match = exact;
      } else {
        const compatible = resolveCompatibleVersion(
          versions.map((version) => version.version),
          versionConstraint
        );
        match = compatible ? versions.find((version) => version.version === compatible) : undefined;
        if (!match) throw new SkillError("SKILL_VERSION_NOT_FOUND", "Invalid version constraint");
      }
    }
    match ??= versions[0];
    if (!match) throw new SkillError("SKILL_VERSION_NOT_FOUND");
    return match;
  }

  private async validateConfiguration(
    manifest: SkillManifest,
    configuration: Record<string, unknown>,
    allowEmptyOverride = false
  ): Promise<Record<string, unknown>> {
    const schema = manifest.configurationSchema;
    if (!schema || Object.keys(configuration).length === 0) {
      if (allowEmptyOverride) return configuration;
      // Only a schema that actually declares required fields makes an empty configuration invalid —
      // a skill whose configurationSchema is entirely optional properties (e.g. file-validation's
      // allowedExtensions/maxSizeBytes) must remain installable with no configuration supplied.
      if (schema && hasRequiredFields(schema))
        throw new SkillError("SKILL_INVALID_CONFIGURATION", "Configuration is required");
      return configuration;
    }
    const cacheKey = `${manifest.key}@${manifest.version}:configuration`;
    let validate = this.schemaCache.get(cacheKey);
    if (!validate) {
      try {
        validate = this.ajv.compile(schema);
      } catch {
        throw new SkillError("SKILL_INVALID_CONFIGURATION");
      }
      this.schemaCache.set(cacheKey, validate);
    }
    if (!validate(configuration)) throw new SkillError("SKILL_INVALID_CONFIGURATION");
    const text = JSON.stringify(configuration);
    if (text && text.length > CONFIGURATION_LIMIT) throw new SkillError("SKILL_INVALID_CONFIGURATION", "Configuration too large");
    return configuration;
  }

  private async assertRequiredDependenciesInstalled(
    organizationId: string,
    manifest: SkillManifest
  ): Promise<void> {
    for (const dependency of manifest.dependencies ?? []) {
      if (!dependency.required) continue;
      const installed = await this.prisma.skillInstallation.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          skillVersion: { skill: { key: dependency.skillKey }, status: "PUBLISHED" }
        },
        include: { skillVersion: true }
      });
      if (!installed) {
        throw new SkillError("SKILL_DEPENDENCY_MISSING", `Required dependency ${dependency.skillKey} must be installed first`);
      }
      if (!versionSatisfies(installed.skillVersion.version, dependency.versionConstraint)) {
        throw new SkillError(
          "SKILL_DEPENDENCY_VERSION_CONFLICT",
          `Dependency ${dependency.skillKey} requires version ${dependency.versionConstraint}`
        );
      }
    }
  }
}

function hasRequiredFields(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.required) && schema.required.length > 0;
}

function readManifest(value: unknown): SkillManifest | null {
  if (!value || typeof value !== "object") return null;
  return value as SkillManifest;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
