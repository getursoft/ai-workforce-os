"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { AccessGate, Can } from "../admin/authorization";
import { useUsers } from "../admin/hooks";
import { useAuth } from "../auth/auth-provider";
import { createTeamApi, type TeamMemberRole, type TeamStatus } from "./team-api";
function useApi() {
  const { client } = useAuth();
  return useMemo(() => createTeamApi(client), [client]);
}
const keys = { all: ["teams"] as const };
export function TeamsPage() {
  const api = useApi();
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState<TeamStatus | "">("");
  const q = useQuery({
    queryKey: [...keys.all, page, search, status],
    queryFn: () => api.list({ page, pageSize: 10, search, ...(status ? { status } : {}) })
  });
  return (
    <AccessGate permission="TEAM_READ">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Teams</h1>
            <p>Organize people into a flexible team hierarchy.</p>
          </div>
          <Can permission="TEAM_CREATE">
            <Link className="ui-button ui-button--primary" href="/team/new">
              New team
            </Link>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="team-search">Search</Label>
          <Input
            id="team-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <Label htmlFor="team-status">Status</Label>
          <select
            id="team-status"
            className="ui-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as TeamStatus | "")}
          >
            <option value="">All statuses</option>
            {["ACTIVE", "INACTIVE", "ARCHIVED"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Card>
        {q.isLoading ? (
          <Skeleton />
        ) : q.error ? (
          <Alert tone="danger" title="Unable to load teams">
            <Button onClick={() => q.refetch()}>Retry</Button>
          </Alert>
        ) : !q.data?.items.length ? (
          <EmptyState title="No teams" description="Create the first team in your organization." />
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Manager</th>
                    <th>Parent</th>
                    <th>Status</th>
                    <th>Members</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.name}</strong>
                        <small>{t.description}</small>
                      </td>
                      <td>
                        {t.manager ? `${t.manager.firstName} ${t.manager.lastName ?? ""}` : "—"}
                      </td>
                      <td>{t.parentTeam?.name ?? "Root"}</td>
                      <td>
                        <Badge>{t.status}</Badge>
                      </td>
                      <td>{t._count?.members ?? 0}</td>
                      <td>
                        <Link href={`/team/${t.id}`}>Manage</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>
                Previous
              </Button>
              <span>
                Page {page} of {Math.max(1, q.data.pagination.pages)}
              </span>
              <Button
                disabled={page >= q.data.pagination.pages}
                onClick={() => setPage((x) => x + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </section>
    </AccessGate>
  );
}
export function NewTeamPage() {
  const api = useApi(),
    router = useRouter();
  const teams = useQuery({ queryKey: keys.all, queryFn: () => api.list({ pageSize: 100 }) }),
    users = useUsers({ pageSize: 100 });
  const m = useMutation({ mutationFn: api.create, onSuccess: (t) => router.push(`/team/${t.id}`) });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const managerId = String(f.get("managerId") ?? ""),
      parentTeamId = String(f.get("parentTeamId") ?? "");
    m.mutate({
      name: String(f.get("name") ?? ""),
      description: String(f.get("description") ?? ""),
      ...(managerId ? { managerId } : {}),
      ...(parentTeamId ? { parentTeamId } : {})
    });
  };
  return (
    <AccessGate permission="TEAM_CREATE">
      <section className="admin-page">
        <Link href="/teams">← Teams</Link>
        <h1>Create team</h1>
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required maxLength={120} />
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" maxLength={500} />
          <Label htmlFor="managerId">Manager</Label>
          <select id="managerId" name="managerId" className="ui-input">
            <option value="">No manager</option>
            {users.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.firstName} {u.lastName} — {u.email}
              </option>
            ))}
          </select>
          <Label htmlFor="parentTeamId">Parent team</Label>
          <select id="parentTeamId" name="parentTeamId" className="ui-input">
            <option value="">Root team</option>
            {teams.data?.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {m.error ? (
            <Alert tone="danger" title="Unable to create team">
              Check the team hierarchy and selected manager.
            </Alert>
          ) : null}
          <Button loading={m.isPending}>Create team</Button>
        </form>
      </section>
    </AccessGate>
  );
}
export function TeamDetailsPage() {
  const { id } = useParams<{ id: string }>(),
    api = useApi(),
    qc = useQueryClient();
  const team = useQuery({ queryKey: [...keys.all, id], queryFn: () => api.get(id) }),
    members = useQuery({
      queryKey: [...keys.all, id, "members"],
      queryFn: () => api.members(id, { pageSize: 100 })
    }),
    users = useUsers({ pageSize: 100 }),
    teams = useQuery({
      queryKey: [...keys.all, "options"],
      queryFn: () => api.list({ pageSize: 100 })
    });
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.all });
  const update = useMutation({
      mutationFn: (v: Parameters<typeof api.update>[1]) => api.update(id, v),
      onSuccess: invalidate
    }),
    add = useMutation({
      mutationFn: (v: { userId: string; role: TeamMemberRole }) =>
        api.addMember(id, v.userId, v.role),
      onSuccess: invalidate
    }),
    remove = useMutation({
      mutationFn: (userId: string) => api.removeMember(id, userId),
      onSuccess: invalidate
    });
  if (team.isLoading) return <Skeleton />;
  if (!team.data)
    return <EmptyState title="Team not found" description="The team may have been archived." />;
  const t = team.data;
  return (
    <AccessGate permission="TEAM_READ">
      <section className="admin-page">
        <Link href="/teams">← Teams</Link>
        <header className="admin-page__header">
          <div>
            <h1>{t.name}</h1>
            <p>{t.description}</p>
          </div>
          <Badge>{t.status}</Badge>
        </header>
        <div className="admin-grid">
          <Card>
            <h2>Hierarchy</h2>
            <p>Parent: {t.parentTeam?.name ?? "Root"}</p>
            {t.childTeams?.map((c) => (
              <p key={c.id}>
                ↳ <Link href={`/team/${c.id}`}>{c.name}</Link>
              </p>
            ))}
            <Can permission="TEAM_UPDATE">
              <Label htmlFor="parent">Move under</Label>
              <select
                id="parent"
                className="ui-input"
                value={t.parentTeamId ?? ""}
                onChange={(e) => update.mutate({ parentTeamId: e.target.value || null })}
              >
                <option value="">Root</option>
                {teams.data?.items
                  .filter((x) => x.id !== id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </Can>
          </Card>
          <Card>
            <h2>Manager</h2>
            <Can permission="TEAM_UPDATE">
              <select
                className="ui-input"
                value={t.managerId ?? ""}
                onChange={(e) => update.mutate({ managerId: e.target.value || null })}
              >
                <option value="">No manager</option>
                {users.data?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName}
                  </option>
                ))}
              </select>
            </Can>
            <p>Created {new Date(t.createdAt).toLocaleDateString()}</p>
          </Card>
        </div>
        <Card>
          <h2>Members</h2>
          <Can permission="TEAM_MEMBER_ADD">
            <form
              className="admin-actions"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                add.mutate({
                  userId: String(f.get("userId")),
                  role: String(f.get("role")) as TeamMemberRole
                });
              }}
            >
              <select name="userId" className="ui-input" required>
                <option value="">Select user</option>
                {users.data?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName}
                  </option>
                ))}
              </select>
              <select name="role" className="ui-input">
                {["MANAGER", "LEAD", "MEMBER"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <Button>Add member</Button>
            </form>
          </Can>
          {members.data?.items.map((m) => (
            <div className="team-member" key={m.userId}>
              <span>
                {m.user.firstName} {m.user.lastName} · {m.user.email}
              </span>
              <Badge>{m.role}</Badge>
              <Can permission="TEAM_MEMBER_UPDATE">
                <select
                  value={m.role}
                  onChange={(e) =>
                    void api
                      .updateMember(id, m.userId, e.target.value as TeamMemberRole)
                      .then(invalidate)
                  }
                >
                  {["MANAGER", "LEAD", "MEMBER"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Can>
              <Can permission="TEAM_MEMBER_REMOVE">
                <Button variant="danger" onClick={() => remove.mutate(m.userId)}>
                  Remove
                </Button>
              </Can>
            </div>
          ))}
        </Card>
        <Can permission="TEAM_DELETE">
          <Button
            variant="danger"
            onClick={() => {
              if (confirm("Archive this team? It will be removed from active team lists."))
                void api.remove(id).then(() => routerPush("/teams"));
            }}
          >
            Archive team
          </Button>
        </Can>
      </section>
    </AccessGate>
  );
}
function routerPush(path: string) {
  window.location.assign(path);
}
