import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SKILL_REGISTRY_METADATA } from "./built-in/skill-registry-metadata.seed";

/**
 * Sprint 6.1B Feature 8 — merges the built-in registry metadata (tags/industry/license/required
 * connectors/supported employees) into each published Skill's existing `metadataJson` column.
 * Idempotent: re-running always converges to the same merged object, never duplicates or drifts.
 * Runs after SkillPublisherService.sync() so the Skill rows already exist.
 */
@Injectable()
export class SkillRegistryMetadataService {
  private readonly logger = new Logger(SkillRegistryMetadataService.name);

  constructor(private readonly prisma: PrismaService) {}

  async sync(): Promise<{ updated: number }> {
    let updated = 0;
    for (const [key, metadata] of Object.entries(SKILL_REGISTRY_METADATA)) {
      const skill = await this.prisma.skill.findUnique({ where: { key }, select: { id: true, metadataJson: true } });
      if (!skill) continue;
      const existing = isRecord(skill.metadataJson) ? skill.metadataJson : {};
      const merged = { ...existing, ...metadata };
      if (deepEqual(existing, merged)) continue;
      await this.prisma.skill.update({
        where: { id: skill.id },
        data: { metadataJson: merged as Prisma.InputJsonValue }
      });
      updated += 1;
    }
    this.logger.log({ event: "SKILL_REGISTRY_METADATA_SYNCED", updated });
    return { updated };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
