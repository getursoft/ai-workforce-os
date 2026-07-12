import type { ApiClient } from "../../lib/api-client";
export type TeamStatus = "ACTIVE" | "INACTIVE" | "ARCHIVED";
export type TeamMemberRole = "MANAGER" | "LEAD" | "MEMBER";
export interface Team {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  managerId: string | null;
  parentTeamId: string | null;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  manager?: { id: string; firstName: string; lastName: string | null; email: string } | null;
  parentTeam?: { id: string; name: string } | null;
  childTeams?: Array<{ id: string; name: string; status: TeamStatus }>;
  _count?: { members: number; childTeams?: number };
}
export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  user: { id: string; firstName: string; lastName: string | null; email: string; status: string };
}
export interface Page<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}
const qs = (input: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(input).forEach(([k, v]) => {
    if (v !== undefined && v !== "") p.set(k, String(v));
  });
  return p.toString() ? `?${p}` : "";
};
export function createTeamApi(client: ApiClient) {
  return {
    list: (
      q: {
        page?: number;
        pageSize?: number;
        search?: string;
        status?: TeamStatus;
        managerId?: string;
        parentTeamId?: string;
      } = {}
    ) => client.request<Page<Team>>(`/teams${qs(q)}`),
    get: (id: string) => client.request<Team>(`/teams/${id}`),
    create: (v: {
      name: string;
      description?: string;
      managerId?: string;
      parentTeamId?: string;
    }) => client.request<Team>("/teams", { method: "POST", body: JSON.stringify(v) }),
    update: (
      id: string,
      v: Partial<Pick<Team, "name" | "description" | "managerId" | "parentTeamId" | "status">>
    ) => client.request<Team>(`/teams/${id}`, { method: "PATCH", body: JSON.stringify(v) }),
    remove: (id: string) => client.request<undefined>(`/teams/${id}`, { method: "DELETE" }),
    members: (
      id: string,
      q: { page?: number; pageSize?: number; search?: string; role?: TeamMemberRole } = {}
    ) => client.request<Page<TeamMember>>(`/teams/${id}/members${qs(q)}`),
    addMember: (id: string, userId: string, role: TeamMemberRole) =>
      client.request<TeamMember>(`/teams/${id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId, role })
      }),
    updateMember: (id: string, userId: string, role: TeamMemberRole) =>
      client.request<TeamMember>(`/teams/${id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      }),
    removeMember: (id: string, userId: string) =>
      client.request<undefined>(`/teams/${id}/members/${userId}`, { method: "DELETE" })
  };
}
