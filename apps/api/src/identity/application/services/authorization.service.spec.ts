import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "./authorization.service";

const prisma = () => ({
  userRole: { findMany: vi.fn() },
  user: { findFirst: vi.fn(), count: vi.fn() },
  permission: { findMany: vi.fn() }
});

describe("AuthorizationService", () => {
  afterEach(() => vi.useRealTimers());
  it("unions permissions across roles and caches the result", async () => {
    const db = prisma();
    db.userRole.findMany.mockResolvedValue([
      { role: { permissions: [{ permission: { key: "users.read" } }] } },
      {
        role: {
          permissions: [
            { permission: { key: "users.write" } },
            { permission: { key: "users.read" } }
          ]
        }
      }
    ]);
    const service = new AuthorizationService(db as never);
    await expect(service.getEffectivePermissions("user", "org")).resolves.toEqual([
      "users.read",
      "users.write"
    ]);
    await expect(
      service.hasAllPermissions("user", "org", ["users.read", "users.write"])
    ).resolves.toBe(true);
    await expect(service.hasPermission("user", "org", "users.read")).resolves.toBe(true);
    await expect(service.hasAnyPermission("user", "org", ["missing", "users.write"])).resolves.toBe(
      true
    );
    await expect(service.hasAnyPermission("user", "org", ["missing"])).resolves.toBe(false);
    expect(db.userRole.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns no permissions for inactive, deleted, or cross-tenant users", async () => {
    const db = prisma();
    db.userRole.findMany.mockResolvedValue([]);
    db.user.findFirst.mockResolvedValue(null);
    const service = new AuthorizationService(db as never);
    await expect(service.getEffectivePermissions("user", "other-org")).resolves.toEqual([]);
    expect(db.userRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user: { organizationId: "other-org", deletedAt: null, status: "ACTIVE" }
        })
      })
    );
  });

  it("expires cached permissions after five minutes", async () => {
    vi.useFakeTimers();
    const db = prisma();
    db.userRole.findMany.mockResolvedValue([
      { role: { permissions: [{ permission: { key: "users.read" } }] } }
    ]);
    const service = new AuthorizationService(db as never);
    await service.getEffectivePermissions("user", "org");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await service.getEffectivePermissions("user", "org");
    expect(db.userRole.findMany).toHaveBeenCalledTimes(2);
  });

  it("checks tenant membership and invalidates cached permissions", async () => {
    const db = prisma();
    db.userRole.findMany.mockResolvedValue([
      { role: { permissions: [{ permission: { key: "roles.read" } }] } }
    ]);
    db.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const service = new AuthorizationService(db as never);
    await expect(service.canAccessOrganization("user", "org-a")).resolves.toBe(true);
    await expect(service.canAccessOrganization("user", "org-b")).resolves.toBe(false);
    await service.getEffectivePermissions("user", "org-a");
    service.invalidateUser("user", "org-a");
    await service.getEffectivePermissions("user", "org-a");
    expect(db.userRole.findMany).toHaveBeenCalledTimes(2);
  });
});
