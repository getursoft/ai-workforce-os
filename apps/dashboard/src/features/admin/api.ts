import type { ApiClient } from "../../lib/api-client";
import type {
  CreateInvitationInput,
  CreateRoleInput,
  CreateUserInput,
  Invitation,
  ManagedUser,
  Permission,
  Role,
  UpdateUserInput,
  UserPage,
  UserQuery
} from "./types";

export function buildQuery(query: UserQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function createAdminApi(client: ApiClient) {
  return {
    listUsers: (query: UserQuery = {}) => client.request<UserPage>(`/users${buildQuery(query)}`),
    getUser: (id: string) => client.request<ManagedUser>(`/users/${id}`),
    createUser: (input: CreateUserInput) =>
      client.request<ManagedUser>("/users", { method: "POST", body: JSON.stringify(input) }),
    updateUser: (id: string, input: UpdateUserInput) =>
      client.request<ManagedUser>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    assignRoles: (id: string, roleIds: string[]) =>
      client.request<ManagedUser>(`/users/${id}/roles`, {
        method: "PATCH",
        body: JSON.stringify({ roleIds })
      }),
    deleteUser: (id: string) => client.request<undefined>(`/users/${id}`, { method: "DELETE" }),
    listRoles: () => client.request<Role[]>("/roles"),
    createRole: (input: CreateRoleInput) =>
      client.request<Role>("/roles", { method: "POST", body: JSON.stringify(input) }),
    updateRole: (id: string, input: Pick<CreateRoleInput, "name" | "description">) =>
      client.request<Role>(`/roles/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    assignPermissions: (id: string, permissionIds: string[]) =>
      client.request<Role>(`/roles/${id}/permissions`, {
        method: "PATCH",
        body: JSON.stringify({ permissionIds })
      }),
    deleteRole: (id: string) => client.request<undefined>(`/roles/${id}`, { method: "DELETE" }),
    listPermissions: () => client.request<Permission[]>("/permissions"),
    listInvitations: () => client.request<Invitation[]>("/invitations"),
    createInvitation: (input: CreateInvitationInput) =>
      client.request<{ invitation: Invitation; token: string }>("/invitations", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    resendInvitation: (id: string) =>
      client.request<{ invitation: Invitation; token: string }>(`/invitations/${id}/resend`, {
        method: "POST"
      }),
    revokeInvitation: (id: string) =>
      client.request<Invitation>(`/invitations/${id}/revoke`, { method: "POST" }),
    acceptInvitation: (input: {
      token: string;
      firstName: string;
      lastName?: string;
      password: string;
    }) =>
      client.request<ManagedUser>(
        "/invitations/accept",
        { method: "POST", body: JSON.stringify(input) },
        { authorize: false, retryOnUnauthorized: false }
      )
  };
}
