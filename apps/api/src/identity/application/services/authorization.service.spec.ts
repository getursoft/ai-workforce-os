import { describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "./authorization.service";

const prisma = () => ({
  userRole: { findMany: vi.fn() },
  user: { findFirst: vi.fn(), count: vi.fn() },
  permission: { findMany: vi.fn() }
});

describe("AuthorizationService", () => {
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
    expect(db.userRole.findMany).toHaveBeenCalledTimes(1);
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
