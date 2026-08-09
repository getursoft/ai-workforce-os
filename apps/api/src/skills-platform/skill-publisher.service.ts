import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillRegistryService } from "./skill-registry.service";
import type { SkillManifest } from "@ai-workforce-os/skill-sdk";
import { SkillManifestValidator, SkillManifestValidationError } from "@ai-workforce-os/skill-sdk";
import { latestVersion } from "@ai-workforce-os/skill-sdk";

/**
 * Idempotent publication lifecycle for built-in skills (Phase 20).
 *
 * The manifest code is authoritative for built-in adapter behavior; the database rows are authoritative
 * for marketplace/install state. This service synchronizes the registry's built-in adapters into the
 * Skill/SkillVersion tables at startup (and on demand) without creating duplicate versions on every
 * boot and without ever overwriting an administrator's installation configuration.
 *
 * Deprecation is an explicit, versioned lifecycle step performed by an administrator or future tooling;
 * this sync only adds/updates metadata for versions that are still published by the running registry.
 */
@Injectable()
export class SkillPublisherService {
  private readonly logger = new Logger(SkillPublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SkillRegistryService,
    private readonly validator: SkillManifestValidator
  ) {}

  /** Synchronizes all registered built-in adapters into the database. Returns counts of created/updated rows. */
  async sync(): Promise<{ skillsCreated: number; skillsUpdated: number; versionsCreated: number; versionsUpdated: number; rejected: string[] }> {
    let skillsCreated = 0;
    let skillsUpdated = 0;
    let versionsCreated = 0;
    let versionsUpdated = 0;
    const rejected: string[] = [];

    for (const adapter of this.registry.all()) {
      const manifest = adapter.manifest;
      try {
        this.validator.validate(manifest);
      } catch (error) {
        const details =
          error instanceof SkillManifestValidationError ? error.details.join("; ") : "invalid manifest";
        rejected.push(`${manifest.key}@${manifest.version}: ${details}`);
        this.logger.error({ event: "SKILL_MANIFEST_REJECTED", skillKey: manifest.key, details });
        continue;
      }

      const existingSkill = await this.prisma.skill.findUnique({ where: { key: manifest.key }, select: { id: true } });
      const skill = await this.prisma.skill.upsert({
        where: { key: manifest.key },
        create: {
          key: manifest.key,
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          author: manifest.author,
          visibility: manifest.visibility,
          icon: null,
          latestVersion: manifest.version
        },
        update: {
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          author: manifest.author,
          visibility: manifest.visibility
        }
      });
      if (!existingSkill) skillsCreated += 1;
      else if (skill.latestVersion !== manifest.version) skillsUpdated += 1;

      const existing = await this.prisma.skillVersion.findUnique({
        where: { skillId_version: { skillId: skill.id, version: manifest.version } }
      });
      if (!existing) {
        await this.prisma.skillVersion.create({
          data: versionData(skill.id, manifest)
        });
        versionsCreated += 1;
      } else {
        await this.prisma.skillVersion.update({
          where: { id: existing.id },
          data: versionData(skill.id, manifest)
        });
        versionsUpdated += 1;
      }
    }

    // Keep latestVersion accurate across all skills after syncing.
    const skills = await this.prisma.skill.findMany({ include: { versions: { select: { version: true, status: true } } } });
    for (const skill of skills) {
      const published = skill.versions
        .filter((version) => version.status === "PUBLISHED")
        .map((version) => version.version);
      const latest = latestVersion(published);
      if (latest && latest !== skill.latestVersion) {
        await this.prisma.skill.update({ where: { id: skill.id }, data: { latestVersion: latest } });
        skillsUpdated += 1;
      }
    }

    this.logger.log({
      event: "SKILL_PUBLICATION_SYNCED",
      skillsCreated,
      skillsUpdated,
      versionsCreated,
      versionsUpdated,
      rejectedCount: rejected.length
    });
    return { skillsCreated, skillsUpdated, versionsCreated, versionsUpdated, rejected };
  }
}

function versionData(skillId: string, manifest: SkillManifest): Prisma.SkillVersionUncheckedCreateInput {
  return {
    skillId,
    version: manifest.version,
    manifestJson: manifest as unknown as Prisma.InputJsonValue,
    inputSchemaJson: manifest.inputSchema as Prisma.InputJsonValue,
    outputSchemaJson: manifest.outputSchema as Prisma.InputJsonValue,
    configurationSchemaJson: manifest.configurationSchema
      ? (manifest.configurationSchema as Prisma.InputJsonValue)
      : Prisma.DbNull,
    requiredPermissionsJson: manifest.requiredPermissions as unknown as Prisma.InputJsonValue,
    requiredCapabilitiesJson: manifest.requiredCapabilities as unknown as Prisma.InputJsonValue,
    dependencyManifestJson:
      manifest.dependencies && manifest.dependencies.length > 0
        ? (manifest.dependencies as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
    billingCategory: manifest.billingCategory,
    runtimeType: "BUILT_IN",
    status: "PUBLISHED",
    publishedAt: new Date()
  };
}
