"use client";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Skeleton
} from "../../components/ui";
import { createPluginApi, type PluginRecord, type PluginStatus } from "./plugin-api";
const key = ["plugins"] as const;
function useApi() {
  const { client } = useAuth();
  return useMemo(() => createPluginApi(client), [client]);
}
export function PluginsPage() {
  const api = useApi(),
    qc = useQueryClient(),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState<PluginStatus | "">(""),
    [install, setInstall] = useState(false),
    [selected, setSelected] = useState<PluginRecord | null>(null),
    [configuration, setConfiguration] = useState<PluginRecord | null>(null);
  const q = useQuery({
    queryKey: [...key, page, search, status],
    queryFn: () =>
      api.list({ page, pageSize: 20, ...(search ? { search } : {}), ...(status ? { status } : {}) })
  });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const state = useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) =>
        active ? api.enable(id) : api.disable(id),
      onSuccess: () => void refresh()
    }),
    remove = useMutation({ mutationFn: api.remove, onSuccess: () => void refresh() });
  return (
    <AccessGate permission="plugin.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Plugins</h1>
            <p>Install and safely configure organization-scoped runtime adapters.</p>
          </div>
          <Can permission="plugin.install">
            <Button onClick={() => setInstall(true)}>Install plugin</Button>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Input
            aria-label="Search plugins"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins"
          />
          <select
            className="ui-input"
            aria-label="Plugin status"
            value={status}
            onChange={(e) => setStatus(e.target.value as PluginStatus | "")}
          >
            <option value="">All statuses</option>
            <option>ACTIVE</option>
            <option>DISABLED</option>
            <option>DEPRECATED</option>
          </select>
        </Card>
        {q.isLoading ? (
          <Skeleton />
        ) : q.error ? (
          <Alert tone="danger" title="Unable to load plugins">
            <Button onClick={() => q.refetch()}>Retry</Button>
          </Alert>
        ) : !q.data?.items.length ? (
          <EmptyState
            title="No plugins installed"
            description="Install the built-in Dummy Echo manifest to verify the runtime."
          />
        ) : (
          <>
            <p>{q.data.pagination.total} installed plugin(s)</p>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Plugin</th>
                    <th>Version</th>
                    <th>Author</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.items.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.displayName}</strong>
                        <small>{p.slug}</small>
                      </td>
                      <td>{p.version}</td>
                      <td>{p.author}</td>
                      <td>
                        <Badge>{p.status}</Badge>
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => setSelected(p)}>
                          Manifest
                        </Button>
                        <Button variant="ghost" onClick={() => setConfiguration(p)}>
                          Configuration
                        </Button>
                        <Can permission="plugin.update">
                          <Button
                            onClick={() =>
                              state.mutate({ id: p.id, active: p.status !== "ACTIVE" })
                            }
                          >
                            {p.status === "ACTIVE" ? "Disable" : "Enable"}
                          </Button>
                        </Can>
                        <Can permission="plugin.delete">
                          <Button
                            variant="danger"
                            onClick={() => confirm("Remove this plugin?") && remove.mutate(p.id)}
                          >
                            Remove
                          </Button>
                        </Can>
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
      <InstallDialog open={install} close={() => setInstall(false)} api={api} refresh={refresh} />
      <Dialog
        open={!!selected}
        onCancel={() => setSelected(null)}
        onConfirm={() => setSelected(null)}
        title="Plugin manifest"
        confirmLabel="Close"
        cancelLabel="Cancel"
      >
        <pre>{JSON.stringify(selected?.manifest, null, 2)}</pre>
      </Dialog>
      {configuration ? (
        <ConfigurationDialog
          plugin={configuration}
          close={() => setConfiguration(null)}
          api={api}
        />
      ) : null}
    </AccessGate>
  );
}
function InstallDialog({
  open,
  close,
  api,
  refresh
}: {
  open: boolean;
  close: () => void;
  api: ReturnType<typeof createPluginApi>;
  refresh: () => Promise<unknown>;
}) {
  const m = useMutation({
    mutationFn: api.install,
    onSuccess: () => {
      void refresh();
      close();
    }
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      m.mutate({
        manifest: JSON.parse(String(f.get("manifest"))) as Record<string, unknown>,
        configuration: {
          config: JSON.parse(String(f.get("config") || "{}")) as Record<string, unknown>,
          secrets: JSON.parse(String(f.get("secrets") || "{}")) as Record<string, string>
        }
      });
    } catch {}
  };
  return (
    <Dialog
      open={open}
      onCancel={close}
      onConfirm={() => undefined}
      title="Install plugin"
      confirmLabel="Use form button"
    >
      <form className="admin-form" onSubmit={submit}>
        <label>
          Manifest JSON
          <textarea className="ui-input" name="manifest" required rows={12} />
        </label>
        <label>
          Configuration JSON
          <textarea className="ui-input" name="config" defaultValue="{}" />
        </label>
        <label>
          Secrets JSON
          <textarea className="ui-input" name="secrets" defaultValue="{}" autoComplete="off" />
        </label>
        {m.error ? (
          <Alert tone="danger" title="Installation failed">
            Validate the manifest, configuration, and secret object.
          </Alert>
        ) : null}
        <Button loading={m.isPending}>Install</Button>
      </form>
    </Dialog>
  );
}
function ConfigurationDialog({
  plugin,
  close,
  api
}: {
  plugin: PluginRecord;
  close: () => void;
  api: ReturnType<typeof createPluginApi>;
}) {
  const q = useQuery({
    queryKey: [...key, plugin.id, "configuration"],
    queryFn: () => api.configuration(plugin.id)
  });
  const m = useMutation({
    mutationFn: (body: {
      config: Record<string, unknown>;
      secrets: Record<string, string | null>;
    }) => api.updateConfiguration(plugin.id, body),
    onSuccess: () => close()
  });
  if (q.isLoading) return <Skeleton />;
  return (
    <Dialog
      open
      onCancel={close}
      onConfirm={() => undefined}
      title={`Configure ${plugin.displayName}`}
      confirmLabel="Use form button"
    >
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            m.mutate({
              config: JSON.parse(String(f.get("config"))) as Record<string, unknown>,
              secrets: JSON.parse(String(f.get("secrets") || "{}")) as Record<string, string | null>
            });
          } catch {}
        }}
      >
        <p>Configured secrets: {q.data?.secretKeys.join(", ") || "None"}</p>
        <label>
          Configuration JSON
          <textarea
            className="ui-input"
            name="config"
            rows={8}
            defaultValue={JSON.stringify(q.data?.config ?? {}, null, 2)}
          />
        </label>
        <label>
          Secret replacements/removals
          <textarea className="ui-input" name="secrets" defaultValue="{}" />
          <small>Omitted keys remain unchanged. Set a key to null to remove it.</small>
        </label>
        <Button loading={m.isPending}>Save</Button>
      </form>
    </Dialog>
  );
}
