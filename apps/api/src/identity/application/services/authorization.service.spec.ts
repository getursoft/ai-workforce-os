import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "./authorization.service";

// Every pre-existing test in this file predates Phase 5.2's organization-status check and implicitly
// assumes an ACTIVE organization — organization.findUnique defaults to that here so none of them had to
// change; CACHE-ORG-SUSPEND-* below are the new tests exercising the SUSPENDED branch explicitly.
const prisma = () => ({
  userRole: { findMany: vi.fn() },
  user: { findFirst: vi.fn(), count: vi.fn() },
  permission: { findMany: vi.fn() },
  organization: { findUnique: vi.fn().mockResolvedValue({ status: "ACTIVE" }) }
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
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
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
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
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
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
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
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
    await expect(service.canAccessOrganization("user", "org-a")).resolves.toBe(true);
    await expect(service.canAccessOrganization("user", "org-b")).resolves.toBe(false);
    await service.getEffectivePermissions("user", "org-a");
    service.invalidateUser("user", "org-a");
    await service.getEffectivePermissions("user", "org-a");
    expect(db.userRole.findMany).toHaveBeenCalledTimes(2);
  });

  it("grants the universal platform owner every permission in any organization", async () => {
    const db = prisma();
    db.userRole.findMany.mockResolvedValue([]);
    db.permission.findMany.mockResolvedValue([{ key: "users.read" }, { key: "billing.payment_settings.manage" }]);
    const service = new AuthorizationService(db as never, {
      isPlatformOwnerEmail: (email: string | null | undefined) => email === "krpandey25646@gmail.com"
    } as never);
    // The owner has no membership row in this org (user.findFirst by org returns null).
    db.user.findFirst.mockImplementation(async ({ where }: { where: { organizationId?: string } }) =>
      where?.organizationId ? null : { email: "krpandey25646@gmail.com" }
    );
    await expect(service.getEffectivePermissions("owner", "other-org")).resolves.toEqual([
      "billing.payment_settings.manage",
      "users.read"
    ]);
    db.user.count.mockResolvedValue(0);
    await expect(service.canAccessOrganization("owner", "other-org")).resolves.toBe(true);
  });

  // --- Phase 5.2 — organization suspension enforcement -------------------------------------------------

  it("CACHE-ORG-SUSPEND-001 getEffectivePermissions returns no permissions for a suspended organization, even for a user who would otherwise be OWNER/ADMIN", async () => {
    const db = prisma();
    db.organization.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    db.user.findFirst.mockResolvedValueOnce({ role: "OWNER" }).mockResolvedValueOnce({ email: "owner@example.invalid" });
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
    await expect(service.getEffectivePermissions("user", "suspended-org")).resolves.toEqual([]);
    // The short-circuit must happen BEFORE any assignment/role lookup — not just filter the result down
    // to empty afterward — proving a suspended org never even queries the tenant's role data.
    expect(db.userRole.findMany).not.toHaveBeenCalled();
  });

  it("CACHE-ORG-SUSPEND-002 getEffectivePermissions returns no permissions for a suspended organization even for the universal platform owner — no exception, matching OrganizationAccessService's existing precedent", async () => {
    const db = prisma();
    db.organization.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    const service = new AuthorizationService(db as never, {
      isPlatformOwnerEmail: (email: string | null | undefined) => email === "krpandey25646@gmail.com"
    } as never);
    await expect(service.getEffectivePermissions("owner", "suspended-org")).resolves.toEqual([]);
    expect(db.permission.findMany).not.toHaveBeenCalled();
  });

  it("CACHE-ORG-SUSPEND-003 canAccessOrganization returns false for a suspended organization even for an otherwise-valid active member", async () => {
    const db = prisma();
    db.organization.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    db.user.count.mockResolvedValue(1); // would be a valid active member if the org were ACTIVE
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
    await expect(service.canAccessOrganization("user", "suspended-org")).resolves.toBe(false);
    // The short-circuit happens before the membership count query is even relevant to the outcome —
    // asserting the organization lookup, not the membership lookup, decided the result.
    expect(db.organization.findUnique).toHaveBeenCalledWith({ where: { id: "suspended-org" }, select: { status: true } });
  });

  it("CACHE-ORG-SUSPEND-004 canAccessOrganization returns false for a suspended organization even for the universal platform owner", async () => {
    const db = prisma();
    db.organization.findUnique.mockResolvedValue({ status: "SUSPENDED" });
    const service = new AuthorizationService(db as never, {
      isPlatformOwnerEmail: (email: string | null | undefined) => email === "krpandey25646@gmail.com"
    } as never);
    await expect(service.canAccessOrganization("owner", "suspended-org")).resolves.toBe(false);
    expect(db.user.findFirst).not.toHaveBeenCalled(); // never even reached the platform-owner lookup
  });

  it("CACHE-ORG-SUSPEND-005 a missing organization row is treated the same as suspended — fail closed, never granted", async () => {
    const db = prisma();
    db.organization.findUnique.mockResolvedValue(null);
    const service = new AuthorizationService(db as never, { isPlatformOwnerEmail: () => false } as never);
    await expect(service.canAccessOrganization("user", "ghost-org")).resolves.toBe(false);
    await expect(service.getEffectivePermissions("user", "ghost-org")).resolves.toEqual([]);
  });
});
