import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";

interface CacheEntry {
  permissions: ReadonlySet<string>;
  expiresAt: number;
}

@Injectable()
export class AuthorizationService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 5 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(
    userId: string,
    organizationId: string,
    jwtPermissions?: readonly string[]
  ): Promise<string[]> {
    const key = `${organizationId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return [...cached.permissions].sort();
    if (jwtPermissions) {
      const permissions = new Set(jwtPermissions);
      this.cache.set(key, { permissions, expiresAt: Date.now() + this.ttlMs });
      return [...permissions].sort();
    }
    const assignments = await this.prisma.userRole.findMany({
      where: {
        userId,
        user: { organizationId, deletedAt: null, status: "ACTIVE" },
        role: { organizationId }
      },
      select: {
        role: { select: { permissions: { select: { permission: { select: { key: true } } } } } }
      }
    });
    const permissions = new Set(
      assignments.flatMap(({ role }) => role.permissions.map(({ permission }) => permission.key))
    );
    if (assignments.length === 0) {
      const user = await this.prisma.user.findFirst({
        where: { id: userId, organizationId, deletedAt: null, status: "ACTIVE" },
        select: { role: true }
      });
      if (user?.role === "OWNER" || user?.role === "ADMIN") {
        for (const permission of await this.prisma.permission.findMany({ select: { key: true } })) {
          permissions.add(permission.key);
        }
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
