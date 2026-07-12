"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../lib/api-error";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  PasswordInput,
  Skeleton
} from "../../components/ui";
import { useAuth } from "../auth/auth-provider";
import { AccessGate, Can } from "./authorization";
import {
  useAdminApi,
  useAdminMutations,
  useInvitations,
  usePermissions,
  useRoles,
  useUser,
  useUsers
} from "./hooks";
import type { Invitation, Permission, Role, UserStatus } from "./types";

const message = (error: unknown) =>
  error instanceof ApiError
    ? ({
        EMAIL_ALREADY_EXISTS: "An account with this email already exists.",
        CONFLICT: "This item conflicts with existing data.",
        AUTHORIZATION_FAILED: "You do not have permission to perform this action.",
        USER_NOT_FOUND: "The requested item was not found."
      }[error.code] ?? error.message)
    : "Something went wrong. Please try again.";
const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "—";
const roleIds = (role: Role) => role.permissions.map(({ permission }) => permission.id);

export function AdminState({
  query,
  empty,
  children
}: {
  query: { isLoading: boolean; error: unknown; refetch(): unknown };
  empty: boolean;
  children: ReactNode;
}) {
  if (query.isLoading)
    return (
      <div className="admin-grid">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    );
  if (query.error)
    return (
      <Alert tone="danger" title="Unable to load">
        <p>{message(query.error)}</p>
        <Button onClick={() => query.refetch()}>Retry</Button>
      </Alert>
    );
  if (empty)
    return (
      <EmptyState title="Nothing here yet" description="No records match the current filters." />
    );
  return children;
}

export function UsersPage() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState<UserStatus | "">(""),
    [role, setRole] = useState(""),
    [createOpen, setCreateOpen] = useState(false),
    [createError, setCreateError] = useState<string | null>(null);
  const query = useUsers({ page, pageSize: 10, search, ...(status ? { status } : {}) }),
    roles = useRoles(),
    mutations = useAdminMutations();
  const items = (query.data?.items ?? []).filter(
    (user) => !role || user.userRoles.some((x) => x.roleId === role)
  );
  return (
    <AccessGate permission="users.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <p className="admin-eyebrow">Administration</p>
            <h1>Users</h1>
            <p>Manage access, status, and role assignments.</p>
          </div>
          <Can permission="users.write">
            <div className="admin-actions">
              <Link className="ui-button ui-button--primary" href="/dashboard/settings/invitations">
                Invite user
              </Link>
              <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                Create directly
              </Button>
            </div>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="user-search">Search</Label>
          <Input
            id="user-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Name or email"
          />
          <Label htmlFor="user-status">Status</Label>
          <select
            id="user-status"
            className="ui-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as UserStatus | "")}
          >
            <option value="">All statuses</option>
            {["ACTIVE", "INVITED", "SUSPENDED", "DISABLED"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <Label htmlFor="user-role">Role</Label>
          <select
            id="user-role"
            className="ui-input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">All roles</option>
            {roles.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Card>
        <AdminState query={query} empty={!items.length}>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.firstName} {user.lastName}
                    </td>
                    <td>{user.email}</td>
                    <td>
                      {user.userRoles.map((x) => (
                        <Badge key={x.roleId}>{x.role.name}</Badge>
                      ))}
                    </td>
                    <td>
                      <Status value={user.status} />
                    </td>
                    <td>{date(user.createdAt)}</td>
                    <td>
                      <Link href={`/dashboard/settings/users/${user.id}`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>
        {query.data ? (
          <nav className="admin-pagination" aria-label="Pagination">
            <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>
              Previous
            </Button>
            <span>
              Page {page} of {Math.max(1, query.data.pagination.pages)}
            </span>
            <Button
              disabled={page >= query.data.pagination.pages}
              onClick={() => setPage((x) => x + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
        <Dialog
          open={createOpen}
          title="Create user"
          description="Create an active account with a temporary password and exact role assignments."
          onCancel={() => setCreateOpen(false)}
          onConfirm={() => {
            const form = document.getElementById("create-user-form") as HTMLFormElement;
            const values = new FormData(form);
            const ids = values.getAll("roleIds").map(String);
            if (ids.length === 0) {
              setCreateError("Select at least one role.");
              return;
            }
            const password = String(values.get("password") ?? "");
            if (password.length < 12) {
              setCreateError(
                "Password must be at least 12 characters and meet the security policy."
              );
              return;
            }
            void mutations.createUser
              .mutateAsync({
                firstName: String(values.get("firstName") ?? "").trim(),
                lastName: String(values.get("lastName") ?? "").trim(),
                email: String(values.get("email") ?? "")
                  .trim()
                  .toLowerCase(),
                password,
                roleIds: ids
              })
              .then(() => {
                setCreateOpen(false);
                setCreateError(null);
              })
              .catch((e) => setCreateError(message(e)));
          }}
        >
          <form id="create-user-form" className="admin-form" onSubmit={(e) => e.preventDefault()}>
            <Label htmlFor="create-first">First name</Label>
            <Input id="create-first" name="firstName" required />
            <Label htmlFor="create-last">Last name</Label>
            <Input id="create-last" name="lastName" />
            <Label htmlFor="create-email">Email</Label>
            <Input id="create-email" name="email" type="email" required />
            <Label htmlFor="create-password">Temporary password</Label>
            <Input id="create-password" name="password" type="password" required />
            <fieldset>
              <legend>Roles</legend>
              {roles.data?.map((item) => (
                <label key={item.id}>
                  <input type="checkbox" name="roleIds" value={item.id} /> {item.name}
                </label>
              ))}
            </fieldset>
            {createError ? (
              <Alert tone="danger" title="Unable to create user">
                {createError}
              </Alert>
            ) : null}
          </form>
        </Dialog>
      </section>
    </AccessGate>
  );
}

export function UserDetailsPage() {
  const { userId } = useParams<{ userId: string }>();
  const q = useUser(userId),
    roles = useRoles(),
    mut = useAdminMutations();
  const { state } = useAuth();
  const [editing, setEditing] = useState(false),
    [confirm, setConfirm] = useState<"delete" | "deactivate" | null>(null),
    [error, setError] = useState<string | null>(null);
  const user = q.data;
  const [selected, setSelected] = useState<string[]>([]);
  if (!user)
    return (
      <AdminState query={q} empty={false}>
        <></>
      </AdminState>
    );
  const protectedUser =
    user.id === state.user?.id || user.userRoles.some((x) => x.role.name === "Owner");
  const change = async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
      await q.refetch();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <AccessGate permission="users.read">
      <section className="admin-page">
        <Link href="/dashboard/settings/users">← Users</Link>
        <header className="admin-page__header">
          <div>
            <h1>
              {user.firstName} {user.lastName}
            </h1>
            <p>{user.email}</p>
          </div>
          <Status value={user.status} />
        </header>
        {error ? (
          <Alert tone="danger" title="Action failed">
            {error}
          </Alert>
        ) : null}
        <div className="admin-grid">
          <Card>
            <h2>Profile</h2>
            <dl className="admin-details">
              <dt>Status</dt>
              <dd>{user.status}</dd>
              <dt>Created</dt>
              <dd>{date(user.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{date(user.updatedAt)}</dd>
            </dl>
            <Can permission="users.write">
              <Button onClick={() => setEditing(true)}>Edit name</Button>
            </Can>
          </Card>
          <Card>
            <h2>Assigned roles</h2>
            <div className="admin-checklist">
              {roles.data?.map((role) => (
                <label key={role.id}>
                  <input
                    type="checkbox"
                    checked={(selected.length
                      ? selected
                      : user.userRoles.map((x) => x.roleId)
                    ).includes(role.id)}
                    onChange={(e) => {
                      const base = selected.length ? selected : user.userRoles.map((x) => x.roleId);
                      setSelected(
                        e.target.checked
                          ? [...new Set([...base, role.id])]
                          : base.filter((x) => x !== role.id)
                      );
                    }}
                  />{" "}
                  <strong>{role.name}</strong> {role.isSystem ? <Badge>System</Badge> : null}
                  <small>{role.description}</small>
                </label>
              ))}
            </div>
            <Can permission="users.write">
              <Button
                disabled={!selected.length}
                loading={mut.assignRoles.isPending}
                onClick={() =>
                  change(() => mut.assignRoles.mutateAsync({ id: user.id, roleIds: selected }))
                }
              >
                Save exact roles
              </Button>
            </Can>
          </Card>
        </div>
        <Can permission="users.write">
          <div className="admin-actions">
            <Button disabled={protectedUser} onClick={() => setConfirm("deactivate")}>
              {user.status === "ACTIVE" ? "Deactivate" : "Activate"}
            </Button>
            <Button variant="danger" disabled={protectedUser} onClick={() => setConfirm("delete")}>
              Delete user
            </Button>
            {protectedUser ? <p>Owner and self-protection prevents destructive actions.</p> : null}
          </div>
        </Can>
        <Dialog
          open={editing}
          title="Edit user"
          onCancel={() => setEditing(false)}
          onConfirm={() => {
            const firstName = (document.getElementById("edit-first") as HTMLInputElement).value;
            void change(() =>
              mut.updateUser.mutateAsync({ id: user.id, input: { firstName } })
            ).then(() => setEditing(false));
          }}
        >
          <Label htmlFor="edit-first">First name</Label>
          <Input id="edit-first" defaultValue={user.firstName} />
        </Dialog>
        <Dialog
          open={confirm !== null}
          title={confirm === "delete" ? "Delete user?" : "Change user access?"}
          description={
            confirm === "delete"
              ? "The user will be soft-deleted and sessions revoked."
              : "Deactivated users cannot access the system."
          }
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const task =
              confirm === "delete"
                ? mut.deleteUser.mutateAsync(user.id)
                : mut.updateUser.mutateAsync({
                    id: user.id,
                    input: { status: user.status === "ACTIVE" ? "DISABLED" : "ACTIVE" }
                  });
            void change(() => task).then(() => setConfirm(null));
          }}
        />
      </section>
    </AccessGate>
  );
}

export function RolesPage() {
  const q = useRoles(),
    mut = useAdminMutations();
  return (
    <AccessGate permission="roles.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <p className="admin-eyebrow">Administration</p>
            <h1>Roles</h1>
            <p>System roles are locked; custom roles can be tailored.</p>
          </div>
          <Can permission="roles.write">
            <Link className="ui-button ui-button--primary" href="/dashboard/settings/roles/new">
              New role
            </Link>
          </Can>
        </header>
        <AdminState query={q} empty={!q.data?.length}>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Type</th>
                  <th>Permissions</th>
                  <th>Users</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.map((role) => (
                  <tr key={role.id}>
                    <td>
                      <strong>{role.name}</strong>
                      <small>{role.description}</small>
                    </td>
                    <td>
                      <Badge tone={role.isSystem ? "neutral" : "success"}>
                        {role.isSystem ? "System · Locked" : "Custom"}
                      </Badge>
                    </td>
                    <td>{role.permissions.length}</td>
                    <td>{role._count?.users ?? 0}</td>
                    <td>{date(role.updatedAt)}</td>
                    <td>
                      <Link href={`/dashboard/settings/roles/${role.id}`}>View</Link>
                      {!role.isSystem ? (
                        <Can permission="roles.write">
                          <Button variant="danger" onClick={() => mut.deleteRole.mutate(role.id)}>
                            Delete
                          </Button>
                        </Can>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>
      </section>
    </AccessGate>
  );
}

export function RoleFormPage() {
  const router = useRouter(),
    permissions = usePermissions(),
    mut = useAdminMutations();
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState<string | null>(null);
  const groups = groupPermissions(
    (permissions.data ?? []).filter((x) => x.key.includes(search.toLowerCase()))
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Role name is required.");
      return;
    }
    try {
      const role = await mut.createRole.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        permissionIds: selected
      });
      router.push(`/dashboard/settings/roles/${role.id}`);
    } catch (x) {
      setError(message(x));
    }
  };
  return (
    <AccessGate permission="roles.write">
      <section className="admin-page">
        <Link href="/dashboard/settings/roles">← Roles</Link>
        <h1>Create custom role</h1>
        {error ? (
          <Alert tone="danger" title="Unable to create role">
            {error}
          </Alert>
        ) : null}
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="role-name">Name</Label>
          <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} />
          <Label htmlFor="role-description">Description</Label>
          <Input
            id="role-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Label htmlFor="permission-search">Search permissions</Label>
          <Input
            id="permission-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <PermissionGroups groups={groups} selected={selected} onChange={setSelected} />
          <p>{selected.length} selected</p>
          <Button loading={mut.createRole.isPending}>Create role</Button>
        </form>
      </section>
    </AccessGate>
  );
}

export function RoleDetailsPage() {
  const { roleId } = useParams<{ roleId: string }>();
  const roles = useRoles(),
    permissions = usePermissions(),
    mut = useAdminMutations();
  const role = roles.data?.find((x) => x.id === roleId);
  const [selected, setSelected] = useState<string[]>([]);
  const current = selected.length ? selected : role ? roleIds(role) : [];
  if (roles.isLoading || permissions.isLoading) return <Skeleton />;
  if (!role)
    return <EmptyState title="Role not found" description="The role may have been removed." />;
  return (
    <AccessGate permission="roles.read">
      <section className="admin-page">
        <Link href="/dashboard/settings/roles">← Roles</Link>
        <header className="admin-page__header">
          <div>
            <h1>{role.name}</h1>
            <p>{role.description}</p>
          </div>
          <Badge>{role.isSystem ? "System · Immutable" : "Custom"}</Badge>
        </header>
        {role.isSystem ? (
          <Alert title="System role">
            System roles and their permission sets cannot be modified.
          </Alert>
        ) : (
          <Can permission="roles.write">
            <Card>
              <h2>Permissions</h2>
              <PermissionGroups
                groups={groupPermissions(permissions.data ?? [])}
                selected={current}
                onChange={setSelected}
              />
              <Button
                disabled={!selected.length}
                loading={mut.assignPermissions.isPending}
                onClick={() =>
                  mut.assignPermissions.mutate({ id: role.id, permissionIds: selected })
                }
              >
                Save exact permissions
              </Button>
            </Card>
          </Can>
        )}
      </section>
    </AccessGate>
  );
}

function PermissionGroups({
  groups,
  selected,
  onChange
}: {
  groups: Record<string, Permission[]>;
  selected: string[];
  onChange(v: string[]): void;
}) {
  return (
    <div className="permission-groups">
      {Object.entries(groups).map(([group, items]) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          <div className="admin-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange([...new Set([...selected, ...items.map((x) => x.id)])])}
            >
              Select all
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(selected.filter((x) => !items.some((y) => y.id === x)))}
            >
              Clear
            </Button>
          </div>
          {items.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, item.id]
                      : selected.filter((x) => x !== item.id)
                  )
                }
              />
              <code>{item.key}</code>
              <small>{item.description}</small>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
const groupPermissions = (items: Permission[]) =>
  items.reduce<Record<string, Permission[]>>((groups, item) => {
    const key = item.key.split(".")[0] ?? "other";
    (groups[key] ??= []).push(item);
    return groups;
  }, {});

export function PermissionsPage() {
  const q = usePermissions();
  const [search, setSearch] = useState(""),
    [resource, setResource] = useState("");
  const items = (q.data ?? []).filter(
    (x) =>
      (!search || `${x.key} ${x.description}`.toLowerCase().includes(search.toLowerCase())) &&
      (!resource || x.key.startsWith(`${resource}.`))
  );
  const resources = [...new Set((q.data ?? []).map((x) => x.key.split(".")[0] ?? "other"))];
  return (
    <AccessGate permission="roles.read">
      <section className="admin-page">
        <h1>Permissions catalogue</h1>
        <p>Read-only permission codes available for custom roles.</p>
        <Card className="admin-toolbar">
          <Input
            aria-label="Search permissions"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="ui-input"
            aria-label="Resource"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
          >
            <option value="">All resources</option>
            {resources.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Card>
        <AdminState query={q} empty={!items.length}>
          <div className="permission-catalogue">
            {items.map((item) => (
              <Card key={item.id}>
                <code>{item.key}</code>
                <h3>{item.key.split(".").join(" · ")}</h3>
                <p>{item.description}</p>
              </Card>
            ))}
          </div>
        </AdminState>
      </section>
    </AccessGate>
  );
}

const invitationStatus = (item: Invitation) =>
  item.acceptedAt
    ? "Accepted"
    : item.revokedAt
      ? "Revoked"
      : new Date(item.expiresAt) <= new Date()
        ? "Expired"
        : "Pending";
export function InvitationsPage() {
  const q = useInvitations(),
    roles = useRoles(),
    mut = useAdminMutations();
  const [email, setEmail] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [open, setOpen] = useState(false),
    [filter, setFilter] = useState("");
  const items = (q.data ?? []).filter((x) => !filter || invitationStatus(x) === filter);
  const create = async () => {
    await mut.createInvitation.mutateAsync({
      email: email.trim().toLowerCase(),
      roleIds: selected
    });
    setOpen(false);
    setEmail("");
    setSelected([]);
  };
  return (
    <AccessGate permission="invitations.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Invitations</h1>
            <p>Invite teammates with one or more roles.</p>
          </div>
          <Can permission="invitations.write">
            <Button onClick={() => setOpen(true)}>Invite user</Button>
          </Can>
        </header>
        <select
          className="ui-input"
          aria-label="Invitation status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {["Pending", "Accepted", "Revoked", "Expired"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <AdminState query={q} empty={!items.length}>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const status = invitationStatus(item);
                  return (
                    <tr key={item.id}>
                      <td>{item.email}</td>
                      <td>
                        {item.roleIds.map((id) => (
                          <Badge key={id}>
                            {roles.data?.find((x) => x.id === id)?.name ?? "Role"}
                          </Badge>
                        ))}
                      </td>
                      <td>
                        <Badge>{status}</Badge>
                      </td>
                      <td>{date(item.createdAt)}</td>
                      <td>{date(item.expiresAt)}</td>
                      <td>
                        {status === "Pending" ? (
                          <Can permission="invitations.write">
                            <Button
                              onClick={() => {
                                if (
                                  confirm(
                                    "The previous invitation link will stop working. Continue?"
                                  )
                                )
                                  mut.resendInvitation.mutate(item.id);
                              }}
                            >
                              Resend
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() => {
                                if (
                                  confirm("The invitation link will no longer be usable. Continue?")
                                )
                                  mut.revokeInvitation.mutate(item.id);
                              }}
                            >
                              Revoke
                            </Button>
                          </Can>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AdminState>
        <Dialog
          open={open}
          title="Invite user"
          description="The invitation will be valid for seven days."
          onCancel={() => setOpen(false)}
          onConfirm={() => void create()}
        >
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div className="admin-checklist">
            {roles.data?.map((role) => (
              <label key={role.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, role.id]
                        : selected.filter((x) => x !== role.id)
                    )
                  }
                />
                {role.name}
                {role.name === "Owner" ? <small>Grants full organization control.</small> : null}
              </label>
            ))}
          </div>
          {mut.createInvitation.error ? (
            <Alert tone="danger" title="Invitation failed">
              {message(mut.createInvitation.error)}
            </Alert>
          ) : null}
        </Dialog>
      </section>
    </AccessGate>
  );
}

function Status({ value }: { value: UserStatus }) {
  return (
    <Badge tone={value === "ACTIVE" ? "success" : value === "SUSPENDED" ? "warning" : "danger"}>
      {value}
    </Badge>
  );
}

export function InvitationAcceptPage() {
  const api = useAdminApi();
  const router = useRouter();
  const [token] = useState(() =>
    typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("token") ?? "")
      : ""
  );
  const [firstName, setFirst] = useState(""),
    [lastName, setLast] = useState(""),
    [password, setPassword] = useState(""),
    [confirmPassword, setConfirm] = useState(""),
    [saving, setSaving] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState<string | null>(
      token ? null : "Invitation token is missing or invalid."
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (
      password.length < 12 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password) ||
      !/[0-9]/.test(password) ||
      !/[^A-Za-z0-9]/.test(password)
    ) {
      setError("Password must meet all security requirements.");
      return;
    }
    setSaving(true);
    try {
      await api.acceptInvitation({ token, firstName, lastName, password });
      setDone(true);
      window.history.replaceState({}, "", "/invitations/accept");
    } catch (x) {
      setError(message(x));
    } finally {
      setSaving(false);
    }
  };
  if (done)
    return (
      <main className="public-card">
        <Card>
          <h1>Invitation accepted</h1>
          <p>Your account is ready.</p>
          <Button onClick={() => router.push("/login")}>Continue to login</Button>
        </Card>
      </main>
    );
  return (
    <main className="public-card">
      <Card>
        <h1>Accept invitation</h1>
        {error ? (
          <Alert tone="danger" title="Unable to accept invitation">
            {error}
          </Alert>
        ) : null}
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="accept-first">First name</Label>
          <Input
            id="accept-first"
            required
            value={firstName}
            onChange={(e) => setFirst(e.target.value)}
          />
          <Label htmlFor="accept-last">Last name</Label>
          <Input id="accept-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
          <PasswordInput
            id="accept-password"
            label="Password"
            value={password}
            onChange={setPassword}
          />
          <PasswordInput
            id="accept-confirm"
            label="Confirm password"
            value={confirmPassword}
            onChange={setConfirm}
          />
          <Button loading={saving} disabled={!token}>
            Create account
          </Button>
        </form>
      </Card>
    </main>
  );
}
