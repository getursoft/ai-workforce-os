import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

/**
 * Sprint 5.0 — Phase 26: tenant-aware feature flags for staged rollout of high-risk integrations
 * (real WhatsApp outbound, real email, the distributed queue, billing enforcement itself, external object
 * storage, automatic collaboration, scheduled proactive messages — see the Sprint 5.0 spec's Phase 25/26).
 *
 * Deliberately NOT an authorization mechanism — RBAC (JwtAccessGuard/PermissionGuard) and
 * EntitlementService remain authoritative for "is this user/org allowed to do X." This answers a narrower
 * question: "is this rollout live yet," independent of permission. Reuses the same FeatureFlag table
 * EntitlementService reads (this is its second consumer) — an org-scoped row overrides the platform-wide
 * default (organizationId: null); no row at all defaults to disabled, so a flag that's never been
 * explicitly turned on for anyone is off by default, not silently on.
 *
 * Platform-wide rows (organizationId: null) are read/written via findFirst + explicit create-or-update
 * rather than Prisma's composite-unique upsert: Postgres treats every NULL in a unique index as distinct
 * from every other NULL, so `@@unique([organizationId, key])` does not actually prevent two platform-wide
 * rows for the same key from being created — `upsert` on that composite key is not safe for the null case.
 * Org-scoped rows (organizationId is a real value) don't have this problem and do use upsert.
 */
@Injectable()
export class FeatureFlagService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(key: string, organizationId?: string): Promise<boolean> {
    if (organizationId) {
      const orgFlag = await this.prisma.featureFlag.findUnique({ where: { organizationId_key: { organizationId, key } } });
      if (orgFlag) return orgFlag.enabled;
    }
    const platformFlag = await this.prisma.featureFlag.findFirst({ where: { organizationId: null, key } });
    return platformFlag?.enabled ?? false;
  }

  async setPlatformFlag(key: string, enabled: boolean, description?: string): Promise<void> {
    const existing = await this.prisma.featureFlag.findFirst({ where: { organizationId: null, key } });
    if (existing) {
      await this.prisma.featureFlag.update({ where: { id: existing.id }, data: { enabled, ...(description !== undefined ? { description } : {}) } });
    } else {
      await this.prisma.featureFlag.create({ data: { organizationId: null, key, enabled, description: description ?? null } });
    }
  }

  async setOrganizationFlag(organizationId: string, key: string, enabled: boolean, description?: string): Promise<void> {
    await this.prisma.featureFlag.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, enabled, description: description ?? null },
      update: { enabled, ...(description !== undefined ? { description } : {}) }
    });
  }
}
