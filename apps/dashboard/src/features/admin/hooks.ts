"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuth } from "../auth/auth-provider";
import { createAdminApi } from "./api";
import type {
  CreateInvitationInput,
  CreateRoleInput,
  CreateUserInput,
  UpdateUserInput,
  UserQuery
} from "./types";
export const adminKeys = {
  users: ["admin", "users"] as const,
  roles: ["admin", "roles"] as const,
  permissions: ["admin", "permissions"] as const,
  invitations: ["admin", "invitations"] as const
};
export function useAdminApi() {
  const { client } = useAuth();
  return useMemo(() => createAdminApi(client), [client]);
}
export function useUsers(query: UserQuery) {
  const api = useAdminApi();
  return useQuery({ queryKey: [...adminKeys.users, query], queryFn: () => api.listUsers(query) });
}
export function useUser(id: string) {
  const api = useAdminApi();
  return useQuery({
    queryKey: [...adminKeys.users, id],
    queryFn: () => api.getUser(id),
    enabled: Boolean(id)
  });
}
export function useRoles() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.roles, queryFn: api.listRoles });
}
export function usePermissions() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.permissions, queryFn: api.listPermissions });
}
export function useInvitations() {
  const api = useAdminApi();
  return useQuery({ queryKey: adminKeys.invitations, queryFn: api.listInvitations });
}
export function useAdminMutations() {
  const api = useAdminApi();
  const q = useQueryClient();
  const invalidate = async () => {
    await Promise.all([
      q.invalidateQueries({ queryKey: adminKeys.users }),
      q.invalidateQueries({ queryKey: adminKeys.roles }),
      q.invalidateQueries({ queryKey: adminKeys.invitations }),
      q.invalidateQueries({ queryKey: ["admin", "current-user"] })
    ]);
  };
  return {
    createUser: useMutation({
      mutationFn: (v: CreateUserInput) => api.createUser(v),
      onSuccess: invalidate
    }),
    updateUser: useMutation({
      mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
        api.updateUser(id, input),
      onSuccess: invalidate
    }),
    assignRoles: useMutation({
      mutationFn: ({ id, roleIds }: { id: string; roleIds: string[] }) =>
        api.assignRoles(id, roleIds),
      onSuccess: invalidate
    }),
    deleteUser: useMutation({ mutationFn: api.deleteUser, onSuccess: invalidate }),
    createRole: useMutation({
      mutationFn: (v: CreateRoleInput) => api.createRole(v),
      onSuccess: invalidate
    }),
    updateRole: useMutation({
      mutationFn: ({
        id,
        input
      }: {
        id: string;
        input: Pick<CreateRoleInput, "name" | "description">;
      }) => api.updateRole(id, input),
      onSuccess: invalidate
    }),
    assignPermissions: useMutation({
      mutationFn: ({ id, permissionIds }: { id: string; permissionIds: string[] }) =>
        api.assignPermissions(id, permissionIds),
      onSuccess: invalidate
    }),
    deleteRole: useMutation({ mutationFn: api.deleteRole, onSuccess: invalidate }),
    createInvitation: useMutation({
      mutationFn: (v: CreateInvitationInput) => api.createInvitation(v),
      onSuccess: invalidate
    }),
    resendInvitation: useMutation({ mutationFn: api.resendInvitation, onSuccess: invalidate }),
    revokeInvitation: useMutation({ mutationFn: api.revokeInvitation, onSuccess: invalidate })
  };
}
