import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PermissionGuard } from "./permission.guard";

function context(
  principal: unknown = {
    userId: { toString: () => "user" },
    organizationId: { toString: () => "org" }
  }
) {
  return {
    getHandler: () => "handler",
    getClass: () => "class",
    switchToHttp: () => ({ getRequest: () => ({ principal }) })
  } as never;
}

describe("PermissionGuard", () => {
  it("allows routes without permission metadata", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    await expect(
      new PermissionGuard(reflector as never, {} as never).canActivate(context())
    ).resolves.toBe(true);
  });

  it("enforces all and any requirements", async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue({ mode: "all", permissions: ["a", "b"] })
    };
    const authorization = {
      hasAllPermissions: vi.fn().mockResolvedValue(true),
      hasAnyPermission: vi.fn().mockResolvedValue(true)
    };
    const guard = new PermissionGuard(reflector as never, authorization as never);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(authorization.hasAllPermissions).toHaveBeenCalledWith("user", "org", ["a", "b"]);
    reflector.getAllAndOverride.mockReturnValue({ mode: "any", permissions: ["a", "b"] });
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(authorization.hasAnyPermission).toHaveBeenCalledWith("user", "org", ["a", "b"]);
  });

  it("denies missing principal and insufficient permissions", async () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue({ mode: "all", permissions: ["a"] })
    };
    const guard = new PermissionGuard(
      reflector as never,
      { hasAllPermissions: vi.fn().mockResolvedValue(false) } as never
    );
    await expect(guard.canActivate(context(null))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });
});
