"use client";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../auth/auth-provider";
import { createAdminApi } from "./api";
import type { Permission, Role } from "./types";

const PermissionContext = createContext<{ values: ReadonlySet<string>; loading: boolean }>({
  values: new Set(),
  loading: true
});
export function PermissionProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { client, state } = useAuth();
  const api = useMemo(() => createAdminApi(client), [client]);
  const isPlatformOwner = state.user?.isPlatformOwner === true;
  const userQuery = useQuery({
    queryKey: ["admin", "current-user", state.user?.id],
    queryFn: () =>
      state.user
        ? api.getUser(state.user.id)
        : Promise.reject(new Error("Current user is unavailable")),
    enabled: Boolean(state.user?.id) && !isPlatformOwner
  });
  const rolesQuery = useQuery({
    queryKey: ["admin", "roles", "permission-source"],
    queryFn: api.listRoles,
    enabled: Boolean(state.user?.id) && !isPlatformOwner
  });
  // The platform owner is a superadmin in every organization on the backend (see
  // AuthorizationService.getEffectivePermissions) even without a role assignment row in the
  // active organization — deriving permissions from userRoles here would incorrectly hide nav
  // items the backend would actually allow. Use the full permission catalogue instead.
  const permissionsCatalogueQuery = useQuery({
    queryKey: ["admin", "permissions", "catalogue"],
    queryFn: api.listPermissions,
    enabled: Boolean(state.user?.id) && isPlatformOwner
  });
  const permissions = useMemo(
    () =>
      isPlatformOwner
        ? allPermissionKeys(permissionsCatalogueQuery.data)
        : extractEffectivePermissions(userQuery.data, rolesQuery.data),
    [isPlatformOwner, permissionsCatalogueQuery.data, rolesQuery.data, userQuery.data]
  );
  return (
    <PermissionContext.Provider
      value={{
        values: permissions,
        loading: isPlatformOwner
          ? permissionsCatalogueQuery.isLoading
          : permissionsAreLoading(userQuery.isLoading, rolesQuery.isLoading)
      }}
    >
      {children}
    </PermissionContext.Provider>
  );
}
export function permissionsAreLoading(userLoading: boolean, rolesLoading: boolean): boolean {
  return userLoading || rolesLoading;
}
export function allPermissionKeys(catalogue: readonly Permission[] = []): ReadonlySet<string> {
  return new Set(catalogue.map((permission) => permission.key));
}
type PermissionUser = {
  userRoles?: Array<{ roleId: string; role?: { permissions?: Role["permissions"] } }>;
};
export function extractEffectivePermissions(
  user?: PermissionUser,
  catalogue: readonly Role[] = []
): ReadonlySet<string> {
  const roleById = new Map(catalogue.map((role) => [role.id, role]));
  const keys = (user?.userRoles ?? []).flatMap((assignment) => {
    const role = roleById.get(assignment.roleId) ?? assignment.role;
    return (role?.permissions ?? []).flatMap((relation) =>
      typeof relation?.permission?.key === "string" ? [relation.permission.key] : []
    );
  });
  return new Set(keys);
}
export function useEffectivePermissions() {
  return useContext(PermissionContext).values;
}
export function hasPermission(values: ReadonlySet<string>, permission: string) {
  return values.has(permission);
}
export function hasAnyPermission(values: ReadonlySet<string>, permissions: readonly string[]) {
  return permissions.some((value) => values.has(value));
}
export function hasAllPermissions(values: ReadonlySet<string>, permissions: readonly string[]) {
  return permissions.every((value) => values.has(value));
}
export function Can({
  permission,
  children
}: Readonly<{ permission: string; children: ReactNode }>) {
  const context = useContext(PermissionContext);
  return !context.loading && context.values.has(permission) ? children : null;
}
export function AccessGate({
  permission,
  children
}: Readonly<{ permission: string; children: ReactNode }>) {
  const context = useContext(PermissionContext);
  if (context.loading)
    return (
      <div className="admin-grid">
        <div className="ui-skeleton" />
      </div>
    );
  return context.values.has(permission) ? (
    children
  ) : (
    <div className="admin-state" role="alert">
      <h2>Access denied</h2>
      <p>You do not have permission to view this page.</p>
    </div>
  );
}

/** Gates a page/section to the single universal platform owner — a session flag, not an org-scoped
 *  permission, so it cannot be checked via AccessGate's permission set. */
export function PlatformOwnerGate({ children }: Readonly<{ children: ReactNode }>) {
  const { state } = useAuth();
  if (state.isInitializing)
    return (
      <div className="admin-grid">
        <div className="ui-skeleton" />
      </div>
    );
  return state.user?.isPlatformOwner ? (
    children
  ) : (
    <div className="admin-state" role="alert">
      <h2>Access denied</h2>
      <p>You do not have permission to view this page.</p>
    </div>
  );
}
