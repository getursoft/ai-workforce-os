import { describe, expect, it, vi } from "vitest";
import { buildQuery, createAdminApi } from "./api";

describe("admin API", () => {
  it("builds user filters without undefined values", () => {
    expect(buildQuery({ page: 2, pageSize: 25, search: "ada", status: "ACTIVE" })).toBe(
      "?page=2&pageSize=25&search=ada&status=ACTIVE"
    );
    expect(buildQuery({})).toBe("");
  });

  it("uses the expected user CRUD and exact-role requests", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createAdminApi({ request } as never);
    await api.listUsers({ page: 1 });
    await api.createUser({
      firstName: "Ada",
      email: "ada@example.com",
      password: "StrongPassword@123",
      roleIds: ["r1"]
    });
    await api.updateUser("u1", { status: "DISABLED" });
    await api.assignRoles("u1", ["r1", "r2"]);
    await api.deleteUser("u1");
    expect(request).toHaveBeenNthCalledWith(1, "/users?page=1");
    expect(request).toHaveBeenCalledWith(
      "/users/u1/roles",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ roleIds: ["r1", "r2"] }) })
    );
    expect(request).toHaveBeenCalledWith("/users/u1", { method: "DELETE" });
  });

  it("covers role, permission, and invitation endpoints", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createAdminApi({ request } as never);
    await api.listRoles();
    await api.createRole({ name: "Auditor", permissionIds: ["p1"] });
    await api.assignPermissions("r1", ["p1"]);
    await api.deleteRole("r1");
    await api.listPermissions();
    await api.listInvitations();
    await api.createInvitation({ email: "a@example.com", roleIds: ["r1"] });
    await api.resendInvitation("i1");
    await api.revokeInvitation("i1");
    expect(request).toHaveBeenCalledWith(
      "/roles/r1/permissions",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(request).toHaveBeenCalledWith("/permissions");
    expect(request).toHaveBeenCalledWith("/invitations/i1/resend", { method: "POST" });
    expect(request).toHaveBeenCalledWith("/invitations/i1/revoke", { method: "POST" });
  });
});
