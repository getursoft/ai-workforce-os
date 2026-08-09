import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { SkillInstallationService } from "./skill-installation.service";
import { SkillDependencyResolverService } from "./skill-dependency-resolver.service";
import { SkillError } from "./skill-error";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

export interface PackItemOutcome {
  skillKey: string;
  outcome: "INSTALLED" | "ALREADY_INSTALLED" | "FAILED";
  error?: string;
}

/**
 * Sprint 6.1B Feature 5 — Skill Packs. Installing a pack never bypasses the existing installation
 * lifecycle: every skill in the pack is installed one at a time through the existing
 * SkillInstallationService.install, in an order the DependencyResolver guarantees is dependency-safe.
 * Removing a pack only removes the pack-level bookkeeping row — it deliberately never uninstalls the
 * underlying skills, since another pack or a manual install may still depend on them.
 */
@Injectable()
export class SkillPackService {
  private readonly logger = new Logger(SkillPackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly installations: SkillInstallationService,
    private readonly resolver: SkillDependencyResolverService,
    @Optional() private readonly audit?: AuditEventLogger
  ) {}

  async listPacks(organizationId: string) {
    const packs = await this.prisma.skillPack.findMany({
      where: { deletedAt: null, isActive: true },
      include: { items: { orderBy: { order: "asc" } } },
      orderBy: { createdAt: "asc" }
    });
    const installations = await this.prisma.skillPackInstallation.findMany({
      where: { organizationId, deletedAt: null }
    });
    const installedByPackId = new Map(installations.map((row) => [row.skillPackId, row]));
    return packs.map((pack) => ({
      ...pack,
      installed: installedByPackId.has(pack.id),
      installation: installedByPackId.get(pack.id) ?? null
    }));
  }

  async installPack(
    organizationId: string,
    userId: string,
    packKey: string,
    approveSensitivePermissions: boolean | undefined,
    requestId?: string
  ) {
    const pack = await this.prisma.skillPack.findFirst({
      where: { key: packKey, deletedAt: null, isActive: true },
      include: { items: { orderBy: { order: "asc" } } }
    });
    if (!pack) throw new SkillError("SKILL_PACK_NOT_FOUND");

    const existing = await this.prisma.skillPackInstallation.findFirst({
      where: { organizationId, skillPackId: pack.id, deletedAt: null }
    });
    if (existing) throw new SkillError("SKILL_PACK_ALREADY_INSTALLED");

    const order = this.resolver.resolveInstallOrder(pack.items.map((item) => item.skillKey));
    const itemByKey = new Map(pack.items.map((item) => [item.skillKey, item]));

    const results: PackItemOutcome[] = [];
    for (const skillKey of order) {
      const item = itemByKey.get(skillKey);
      const alreadyInstalled = await this.prisma.skillInstallation.findFirst({
        where: { organizationId, deletedAt: null, skillVersion: { skill: { key: skillKey } } }
      });
      if (alreadyInstalled) {
        results.push({ skillKey, outcome: "ALREADY_INSTALLED" });
        continue;
      }
      try {
        await this.installations.install(
          organizationId,
          userId,
          {
            skillKey,
            ...(item?.versionConstraint ? { versionConstraint: item.versionConstraint } : {}),
            enabled: true,
            ...(approveSensitivePermissions !== undefined ? { approveSensitivePermissions } : {})
          },
          requestId
        );
        results.push({ skillKey, outcome: "INSTALLED" });
      } catch (error) {
        this.logger.warn({ event: "SKILL_PACK_ITEM_INSTALL_FAILED", packKey, skillKey, error: String(error) });
        results.push({ skillKey, outcome: "FAILED", error: error instanceof Error ? error.message : "unknown" });
      }
    }

    const anyFailed = results.some((result) => result.outcome === "FAILED");
    const installation = await this.prisma.skillPackInstallation.create({
      data: {
        organizationId,
        skillPackId: pack.id,
        packVersion: pack.version,
        status: anyFailed ? "PARTIAL" : "INSTALLED",
        installedByUserId: userId
      }
    });

    this.audit?.record("SKILL_PACK_INSTALLED", requestId ?? "skill-pack-install", {
      organizationId,
      userId,
      packKey,
      status: installation.status,
      items: results.length
    });

    return { installation, results };
  }

  async updatePack(organizationId: string, userId: string, packKey: string, requestId?: string) {
    const pack = await this.prisma.skillPack.findFirst({ where: { key: packKey, deletedAt: null } });
    if (!pack) throw new SkillError("SKILL_PACK_NOT_FOUND");
    const existing = await this.prisma.skillPackInstallation.findFirst({
      where: { organizationId, skillPackId: pack.id, deletedAt: null }
    });
    if (!existing) throw new SkillError("SKILL_PACK_NOT_FOUND", "Pack is not installed for this organization");

    // Re-run the same install logic (idempotent per item — already-installed skills are skipped) so a
    // newer pack version's newly-added items get installed without touching existing ones.
    const items = await this.prisma.skillPackItem.findMany({ where: { skillPackId: pack.id }, orderBy: { order: "asc" } });
    const order = this.resolver.resolveInstallOrder(items.map((item) => item.skillKey));
    const itemByKey = new Map(items.map((item) => [item.skillKey, item]));
    const results: PackItemOutcome[] = [];
    for (const skillKey of order) {
      const item = itemByKey.get(skillKey);
      const alreadyInstalled = await this.prisma.skillInstallation.findFirst({
        where: { organizationId, deletedAt: null, skillVersion: { skill: { key: skillKey } } }
      });
      if (alreadyInstalled) {
        results.push({ skillKey, outcome: "ALREADY_INSTALLED" });
        continue;
      }
      try {
        await this.installations.install(
          organizationId,
          userId,
          { skillKey, ...(item?.versionConstraint ? { versionConstraint: item.versionConstraint } : {}), enabled: true },
          requestId
        );
        results.push({ skillKey, outcome: "INSTALLED" });
      } catch (error) {
        results.push({ skillKey, outcome: "FAILED", error: error instanceof Error ? error.message : "unknown" });
      }
    }

    const updated = await this.prisma.skillPackInstallation.update({
      where: { id: existing.id },
      data: { packVersion: pack.version, status: results.some((r) => r.outcome === "FAILED") ? "PARTIAL" : "INSTALLED" }
    });
    this.audit?.record("SKILL_PACK_UPDATED", requestId ?? "skill-pack-update", { organizationId, userId, packKey });
    return { installation: updated, results };
  }

  async removePack(organizationId: string, userId: string, packKey: string, requestId?: string) {
    const pack = await this.prisma.skillPack.findFirst({ where: { key: packKey } });
    if (!pack) throw new SkillError("SKILL_PACK_NOT_FOUND");
    const existing = await this.prisma.skillPackInstallation.findFirst({
      where: { organizationId, skillPackId: pack.id, deletedAt: null }
    });
    if (!existing) throw new SkillError("SKILL_PACK_NOT_FOUND", "Pack is not installed for this organization");
    await this.prisma.skillPackInstallation.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), status: "UNINSTALLED" }
    });
    this.audit?.record("SKILL_PACK_REMOVED", requestId ?? "skill-pack-remove", { organizationId, userId, packKey });
    return { removed: true, packKey };
  }
}
