import { Injectable } from "@nestjs/common";
import { OrganizationStatus } from "@prisma/client";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { PlatformOwnerService } from "../../infrastructure/security/platform-owner.service";

interface CacheEntry {
  permissions: ReadonlySet<string>;
  expiresAt: number;
}

@Injectable()
export class AuthorizationService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformOwner: PlatformOwnerService
  ) {}

  async getEffectivePermissions(
    userId: string,
    organizationId: string,
    jwtPermissions?: readonly string[]
  ): Promise<string[]> {
    const key = `${organizationId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return [...cached.permissions].sort();
    // Phase 5.2 — organization suspension enforcement. A non-ACTIVE organization has zero effective
    // permissions for every principal resolved into it, no exceptions (matches the already-established
    // OrganizationAccessService precedent, which does not exempt the platform owner either). Checked
    // first, before the jwtPermissions shortcut or the platform-owner/OWNER-ADMIN fallback below, so a
    // suspension can never be bypassed by any of those paths. invalidateOrganization() is called by
    // suspendOrganization/reactivateOrganization (platform.service.ts), so a cached grant from before the
    // suspension is also cleared immediately — this check only has to handle the fresh-computation path,
    // but it is what makes the fresh computation itself correct.
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { status: true }
    });
    if (!organization || organization.status !== OrganizationStatus.ACTIVE) {
      this.cache.set(key, { permissions: new Set(), expiresAt: Date.now() + this.ttlMs });
      return [];
    }
    if (jwtPermissions) {
      const permissions = new Set(jwtPermissions);
      this.cache.set(key, { permissions, expiresAt: Date.now() + this.ttlMs });
      return [...permissions].sort();
    }
    const [assignments, userInOrg, anyUser] = await Promise.all([
      this.prisma.userRole.findMany({
        where: {
          userId,
          user: { organizationId, deletedAt: null, status: "ACTIVE" },
          role: { organizationId }
        },
        select: {
          role: { select: { permissions: { select: { permission: { select: { key: true } } } } } }
        }
      }),
      this.prisma.user.findFirst({
        where: { id: userId, organizationId, deletedAt: null },
        select: { role: true }
      }),
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { email: true }
      })
    ]);
    const permissions = new Set(
      assignments.flatMap(({ role }) => role.permissions.map(({ permission }) => permission.key))
    );
    // The universal platform owner is a superadmin in EVERY organization — all permissions apply,
    // including in organizations they have no membership row in (org-switch sessions).
    if (anyUser && this.platformOwner.isPlatformOwnerEmail(anyUser.email)) {
      const all = await this.prisma.permission.findMany({ select: { key: true } });
      for (const permission of all) permissions.add(permission.key);
    } else if (assignments.length === 0 && (userInOrg?.role === "OWNER" || userInOrg?.role === "ADMIN")) {
      for (const permission of await this.prisma.permission.findMany({ select: { key: true } })) {
        permissions.add(permission.key);
      }
    }
    this.cache.set(key, { permissions, expiresAt: Date.now() + this.ttlMs });
    return [...permissions].sort();
  }

  async hasPermission(
    userId: string,
    organizationId: string,
    permission: string
  ): Promise<boolean> {
    return (await this.getEffectivePermissions(userId, organizationId)).includes(permission);
  }
  async hasAnyPermission(
    userId: string,
    organizationId: string,
    permissions: readonly string[]
  ): Promise<boolean> {
    const effective = new Set(await this.getEffectivePermissions(userId, organizationId));
    return permissions.some((permission) => effective.has(permission));
  }
  async hasAllPermissions(
    userId: string,
    organizationId: string,
    permissions: readonly string[]
  ): Promise<boolean> {
    const effective = new Set(await this.getEffectivePermissions(userId, organizationId));
    return permissions.every((permission) => effective.has(permission));
  }
  async canAccessOrganization(userId: string, organizationId: string): Promise<boolean> {
    // Phase 5.2 — checked first, unconditionally, before the platform-owner shortcut below: a suspended
    // organization blocks everyone resolved into it, no exceptions (same policy as getEffectivePermissions
    // above and the pre-existing OrganizationAccessService). This is also the method the recruitment
    // export worker's background job already calls to re-verify authorization before and during
    // processing (RecruitmentExportWorkerService.isRequesterAuthorized) — fixing it here, in one place,
    // makes that existing worker architecture suspension-aware with no worker-specific code change.
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { status: true }
    });
    if (!organization || organization.status !== OrganizationStatus.ACTIVE) return false;
    const owner = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { email: true }
    });
    if (owner && this.platformOwner.isPlatformOwnerEmail(owner.email)) return true;
    return (
      (await this.prisma.user.count({
        where: { id: userId, organizationId, deletedAt: null, status: "ACTIVE" }
      })) === 1
    );
  }
  invalidateUser(userId: string, organizationId: string): void {
    this.cache.delete(`${organizationId}:${userId}`);
  }
  invalidateOrganization(organizationId: string): void {
    for (const key of this.cache.keys())
      if (key.startsWith(`${organizationId}:`)) this.cache.delete(key);
  }
}
