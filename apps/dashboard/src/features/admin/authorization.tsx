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
  // Self-scoped — `GET /auth/me/permissions` needs only a valid session, unlike the admin-only
  // `GET /users/:id` + `GET /roles` this used to derive permissions from (both require `users.read`/
  // `roles.read`, permissions only the Owner *role* happens to hold — every other role, including
  // Member and Viewer, would 403 on both calls and silently see "Access denied" everywhere in the
  // dashboard regardless of what they could actually do). See UAT-007 in
  // docs/production/full-platform-uat-defects.md for the full trace of this.
  const myPermissionsQuery = useQuery({
    queryKey: ["auth", "me", "permissions", state.user?.id],
    queryFn: () => client.myPermissions(),
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
        : new Set(myPermissionsQuery.data ?? []),
    [isPlatformOwner, permissionsCatalogueQuery.data, myPermissionsQuery.data]
  );
  return (
    <PermissionContext.Provider
      value={{
        values: permissions,
        loading: isPlatformOwner ? permissionsCatalogueQuery.isLoading : myPermissionsQuery.isLoading
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
}: Readonly<{ permission: string | readonly string[]; children: ReactNode }>) {
  const context = useContext(PermissionContext);
  if (context.loading)
    return (
      <div className="admin-grid">
        <div className="ui-skeleton" />
      </div>
    );
  // An array means "any of these" (e.g. a read-only permission alongside the broader one it was split
  // out of, so a role holding either can still see the page) — a single string keeps its original exact
  // meaning for every other call site.
  const allowed = Array.isArray(permission)
    ? hasAnyPermission(context.values, permission)
    : context.values.has(permission as string);
  return allowed ? (
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
