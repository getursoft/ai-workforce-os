import { describe, expect, it } from "vitest";
import {
  extractEffectivePermissions,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsAreLoading
} from "./authorization";
import type { ManagedUser, Role } from "./types";
describe("frontend authorization", () => {
  it("checks single, any, all, and empty permissions", () => {
    const values = new Set(["users.read", "roles.read"]);
    expect(hasPermission(values, "users.read")).toBe(true);
    expect(hasAnyPermission(values, ["missing", "roles.read"])).toBe(true);
    expect(hasAllPermissions(values, ["users.read", "roles.read"])).toBe(true);
    expect(hasAllPermissions(values, ["users.read", "users.write"])).toBe(false);
    expect(hasPermission(new Set(), "users.read")).toBe(false);
  });
  it("extracts Owner permissions from the role catalogue response", () => {
    const user = {
      userRoles: [{ roleId: "owner", assignedAt: "", role: { id: "owner", name: "Owner" } }]
    } as ManagedUser;
    const roles = [
      {
        id: "owner",
        permissions: [
          { permission: { id: "p1", key: "users.read", description: null } },
          { permission: { id: "p2", key: "roles.read", description: null } }
        ]
      }
    ] as Role[];
    expect([...extractEffectivePermissions(user, roles)].sort()).toEqual([
      "roles.read",
      "users.read"
    ]);
  });
  it("unions multiple roles and removes duplicate permission keys", () => {
    const user = { userRoles: [{ roleId: "one" }, { roleId: "two" }] } as ManagedUser;
    const roles = [
      { id: "one", permissions: [{ permission: { key: "users.read" } }] },
      {
        id: "two",
        permissions: [{ permission: { key: "users.read" } }, { permission: { key: "users.write" } }]
      }
    ] as Role[];
    expect([...extractEffectivePermissions(user, roles)].sort()).toEqual([
      "users.read",
      "users.write"
    ]);
  });
  it("handles roles with no or missing permission relations and empty assignments", () => {
    expect([
      ...extractEffectivePermissions(
        { userRoles: [{ roleId: "empty" }] } as ManagedUser,
        [{ id: "empty", permissions: [] }] as unknown as Role[]
      )
    ]).toEqual([]);
    expect([
      ...extractEffectivePermissions({
        userRoles: [{ roleId: "missing", role: { id: "missing" } }]
      } as ManagedUser)
    ]).toEqual([]);
    expect([...extractEffectivePermissions({ userRoles: [] } as unknown as ManagedUser)]).toEqual(
      []
    );
    expect([...extractEffectivePermissions({} as ManagedUser)]).toEqual([]);
  });
  it("keeps the provider loading until both contract queries settle", () => {
    expect(permissionsAreLoading(true, false)).toBe(true);
    expect(permissionsAreLoading(false, true)).toBe(true);
    expect(permissionsAreLoading(false, false)).toBe(false);
  });
});
