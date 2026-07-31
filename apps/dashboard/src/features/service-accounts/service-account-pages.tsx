"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  BackLink,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { AccessGate, Can } from "../admin/authorization";
import { useRoles } from "../admin/hooks";
import { useAuth } from "../auth/auth-provider";
import { createServiceAccountApi, type AccountStatus } from "./service-account-api";
function useApi() {
  const { client } = useAuth();
  return useMemo(() => createServiceAccountApi(client), [client]);
}
const keys = ["service-accounts"] as const;
export function ServiceAccountsPage() {
  const api = useApi();
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState<AccountStatus | "">("");
  const q = useQuery({
    queryKey: [...keys, page, search, status],
    queryFn: () => api.list({ page, pageSize: 10, search, status: status || undefined })
  });
  return (
    <AccessGate permission="service_accounts.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Service accounts</h1>
            <p>Machine identities for integrations, bots, workers, and automation.</p>
          </div>
          <Can permission="service_accounts.create">
            <Link href="/dashboard/service-accounts/new" className="ui-button ui-button--primary">
              Create service account
            </Link>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Input
            aria-label="Search service accounts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
          />
          <select
            className="ui-input"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as AccountStatus | "")}
          >
            <option value="">All statuses</option>
            {["ACTIVE", "DISABLED", "ARCHIVED"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Card>
        {q.isLoading ? (
          <Skeleton />
        ) : q.error ? (
          <Alert tone="danger" title="Unable to load service accounts">
            <Button onClick={() => q.refetch()}>Retry</Button>
          </Alert>
        ) : !q.data?.items.length ? (
          <EmptyState
            title="No service accounts"
            description="Create a secure machine identity to get started."
          />
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Roles</th>
                    <th>Keys</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.name}</strong>
                        <small>{a.description}</small>
                      </td>
                      <td>
                        <Badge>{a.status}</Badge>
                      </td>
                      <td>
                        {a.roles.map((x) => (
                          <Badge key={x.roleId}>{x.role.name}</Badge>
                        ))}
                      </td>
                      <td>{a._count?.apiKeys ?? 0}</td>
                      <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                      <td>
                        <Link href={`/dashboard/service-accounts/${a.id}`}>Manage</Link>
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
              <span>Page {page}</span>
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
export function NewServiceAccountPage() {
  const api = useApi(),
    roles = useRoles(),
    router = useRouter();
  const m = useMutation({
    mutationFn: api.create,
    onSuccess: (a) => router.push(`/dashboard/service-accounts/${a.id}`)
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    m.mutate({
      name: String(f.get("name")),
      description: String(f.get("description")),
      roleIds: f.getAll("roleIds").map(String)
    });
  };
  return (
    <AccessGate permission="service_accounts.create">
      <section className="admin-page">
        <BackLink href="/dashboard/service-accounts" label="Back to Service Accounts" />
        <h1>Create service account</h1>
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="sa-name">Name</Label>
          <Input id="sa-name" name="name" required maxLength={120} />
          <Label htmlFor="sa-description">Description</Label>
          <Input id="sa-description" name="description" maxLength={500} />
          <fieldset>
            <legend>Roles</legend>
            {roles.data
              ?.filter((r) => !r.isSystem || !["Owner", "Admin"].includes(r.name))
              .map((r) => (
                <label key={r.id}>
                  <input type="checkbox" name="roleIds" value={r.id} />
                  {r.name}
                </label>
              ))}
          </fieldset>
          {m.error ? (
            <Alert tone="danger" title="Unable to create">
              Check the name and role selection.
            </Alert>
          ) : null}
          <Button loading={m.isPending}>Create</Button>
        </form>
      </section>
    </AccessGate>
  );
}
export function ServiceAccountDetailsPage() {
  const { id } = useParams<{ id: string }>(),
    api = useApi(),
    qc = useQueryClient();
  const q = useQuery({ queryKey: [...keys, id], queryFn: () => api.get(id) });
  const [secret, setSecret] = useState<string | null>(null),
    [ack, setAck] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys });
  const create = useMutation({
      mutationFn: (v: { name: string; environment: string; expiresAt?: string }) =>
        api.createKey(id, v),
      onSuccess: (r) => {
        setSecret(r.secret);
        void refresh();
      }
    }),
    rotate = useMutation({
      mutationFn: (keyId: string) => api.rotate(id, keyId),
      onSuccess: (r) => {
        setSecret(r.secret);
        void refresh();
      }
    });
  if (q.isLoading) return <Skeleton />;
  if (!q.data)
    return (
      <EmptyState title="Service account not found" description="It may have been archived." />
    );
  const a = q.data;
  return (
    <AccessGate permission="service_accounts.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/dashboard/service-accounts" label="Back to Service Accounts" />
            <h1>{a.name}</h1>
            <p>{a.description}</p>
          </div>
          <Badge>{a.status}</Badge>
        </header>
        <Card>
          <div className="admin-section-header">
            <h2>API keys</h2>
          </div>
          <Can permission="api_keys.create">
            <form
              className="admin-actions"
              style={{ marginBottom: 16 }}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                create.mutate({
                  name: String(f.get("name")),
                  environment: String(f.get("environment")),
                  ...(f.get("expiresAt") ? { expiresAt: String(f.get("expiresAt")) } : {})
                });
              }}
            >
              <Input name="name" placeholder="Key label" required />
              <select name="environment" className="ui-input">
                <option>LIVE</option>
                <option>TEST</option>
                <option>DEVELOPMENT</option>
              </select>
              <Input name="expiresAt" type="datetime-local" />
              <Button loading={create.isPending}>Generate key</Button>
            </form>
          </Can>
          {a.apiKeys?.map((k) => (
            <div className="team-member" key={k.id}>
              <span>
                <strong>{k.name}</strong> <code>{k.maskedValue}</code>
                <small>
                  Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                </small>
              </span>
              <Badge>{k.status}</Badge>
              {k.status === "ACTIVE" ? (
                <>
                  <Can permission="api_keys.rotate">
                    <Button
                      onClick={() =>
                        confirm("Rotate this key? The old key will stop working immediately.") &&
                        rotate.mutate(k.id)
                      }
                    >
                      Rotate
                    </Button>
                  </Can>
                  <Can permission="api_keys.revoke">
                    <Button
                      variant="danger"
                      onClick={() =>
                        confirm("Revoke this key immediately?") &&
                        void api.revoke(id, k.id).then(refresh)
                      }
                    >
                      Revoke
                    </Button>
                  </Can>
                </>
              ) : null}
            </div>
          ))}
        </Card>
        <Can permission="service_accounts.update">
          <Button
            onClick={() =>
              void api
                .update(id, { status: a.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })
                .then(refresh)
            }
          >
            {a.status === "ACTIVE" ? "Disable" : "Enable"}
          </Button>
        </Can>
        <Can permission="service_accounts.delete">
          <Button
            variant="danger"
            onClick={() =>
              confirm("Archive this service account and revoke all keys?") &&
              void api.remove(id).then(() => location.assign("/dashboard/service-accounts"))
            }
          >
            Archive
          </Button>
        </Can>
        <Dialog
          open={Boolean(secret)}
          title="Copy your API key"
          description="This secret will never be displayed again."
          onCancel={() => {
            if (ack) {
              setSecret(null);
              setAck(false);
            }
          }}
          onConfirm={() => {
            if (ack) {
              setSecret(null);
              setAck(false);
            }
          }}
        >
          <Input readOnly value={secret ?? ""} aria-label="One-time API key" />
          <Button type="button" onClick={() => secret && navigator.clipboard.writeText(secret)}>
            Copy
          </Button>
          <label>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
            have stored this key securely.
          </label>
        </Dialog>
      </section>
    </AccessGate>
  );
}
