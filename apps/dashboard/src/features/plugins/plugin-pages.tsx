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
import {
  createPluginApi,
  saveAndTestAiConfiguration,
  type PluginAiConfiguration,
  type PluginRecord,
  type PluginStatus,
  type PublicPluginManifest
} from "./plugin-api";
import { SchemaFields, valuesFromForm, isSecretProperty } from "./plugin-schema-form";
import { canInstallPlugin, displayedHealth, isHealthPending } from "./plugin-page.logic";
import { CapabilityGrants } from "./capability-grants";
import { AiProviderForm } from "./ai-provider-form";
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
    [install, setInstall] = useState<PublicPluginManifest | null>(null),
    [selected, setSelected] = useState<PluginRecord | null>(null),
    [configuration, setConfiguration] = useState<PluginRecord | null>(null);
  const q = useQuery({
    queryKey: [...key, page, search, status],
    queryFn: () =>
      api.list({ page, pageSize: 20, ...(search ? { search } : {}), ...(status ? { status } : {}) })
  });
  const available = useQuery({ queryKey: [...key, "available"], queryFn: api.available });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const state = useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) =>
        active ? api.enable(id) : api.disable(id),
      onSuccess: () => void refresh()
    }),
    remove = useMutation({ mutationFn: api.remove, onSuccess: () => void refresh() }),
    health = useMutation({ mutationFn: api.health, onSuccess: () => void refresh() });
  return (
    <AccessGate permission="plugin.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Plugins</h1>
            <p>Install and safely configure organization-scoped runtime adapters.</p>
          </div>
        </header>
        <div className="admin-section-header">
          <div>
            <h2>Available plugins</h2>
            <p>Install trusted repository plugins.</p>
          </div>
        </div>
        {available.isLoading ? (
          <Skeleton />
        ) : available.data?.items.length ? (
          <div className="admin-grid">
            {available.data.items.map((manifest) => (
              <div key={manifest.id} className="admin-grid-card">
                <div>
                  <strong>{manifest.displayName}</strong>
                  <p>{manifest.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{manifest.version}</Badge>
                  <Can permission="plugin.install">
                    {!canInstallPlugin(manifest) ? (
                      <>
                        <Badge>Installed</Badge>
                        <Button
                          disabled
                          aria-label={`${manifest.displayName} is already installed`}
                        >
                          Installed
                        </Button>
                      </>
                    ) : (
                      <Button
                        onClick={() => setInstall(manifest)}
                        aria-label={`Install ${manifest.displayName}`}
                      >
                        Install
                      </Button>
                    )}
                  </Can>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>No trusted repository plugins were discovered.</p>
        )}
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
                    <th>Lifecycle status</th>
                    <th>Health</th>
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
                        <Badge>{displayedHealth(p.lastHealthStatus)}</Badge>
                        {p.lastHealthCheckedAt ? (
                          <small>{new Date(p.lastHealthCheckedAt).toLocaleString()}</small>
                        ) : null}
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => setSelected(p)}>
                          Manifest
                        </Button>
                        <Button variant="ghost" onClick={() => setConfiguration(p)}>
                          Configuration
                        </Button>
                        <Button
                          variant="ghost"
                          loading={isHealthPending(health.isPending, health.variables, p.id)}
                          disabled={isHealthPending(health.isPending, health.variables, p.id)}
                          onClick={() => health.mutate(p.id)}
                          aria-label={`Check health for ${p.displayName}`}
                        >
                          Check health
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
                        {health.isError && health.variables === p.id ? (
                          <small role="alert">Health check failed. Try again.</small>
                        ) : null}
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
      <InstallDialog plugin={install} close={() => setInstall(null)} api={api} refresh={refresh} />
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
          refresh={refresh}
        />
      ) : null}
    </AccessGate>
  );
}
function InstallDialog({
  plugin,
  close,
  api,
  refresh
}: {
  plugin: PublicPluginManifest | null;
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
    if (!plugin || m.isPending) return;
    const form = e.currentTarget,
      data = new FormData(form),
      declared = new Set(plugin.permissions),
      granted = data
        .getAll("permission")
        .map(String)
        .filter((permission) => declared.has(permission));
    m.mutate({
      pluginId: plugin.id,
      grantedPermissions: granted,
      configuration: {
        config: valuesFromForm(form, plugin.configSchema, false),
        secrets: valuesFromForm(form, plugin.configSchema, true) as Record<string, string>
      },
      enable: data.get("enable") !== null
    });
  };
  if (!plugin) return null;
  const secretFields = Object.values(plugin.configSchema?.properties ?? {}).some(isSecretProperty);
  return (
    <Dialog
      open
      onCancel={close}
      onConfirm={() => undefined}
      title={`Install ${plugin.displayName}`}
      description={plugin.description}
      showActions={false}
    >
      <form className="admin-form" onSubmit={submit}>
        <section>
          <h3>Plugin details</h3>
          <dl>
            <dt>Version</dt>
            <dd>{plugin.version}</dd>
            <dt>Author</dt>
            <dd>{plugin.author}</dd>
          </dl>
          <div>
            {plugin.capabilities.map((capability) => (
              <Badge key={capability}>{capability}</Badge>
            ))}
          </div>
        </section>
        <fieldset>
          <legend>Permissions</legend>
          {plugin.permissions.length ? (
            plugin.permissions.map((permission) => (
              <label key={permission}>
                <input type="checkbox" name="permission" value={permission} />
                <span>
                  <strong>{permission}</strong>
                  <small>{permissionDescription(permission)}</small>
                </span>
              </label>
            ))
          ) : (
            <p>This plugin requests no service permissions.</p>
          )}
        </fieldset>
        {Object.values(plugin.configSchema?.properties ?? {}).some(
          (property) => !isSecretProperty(property)
        ) ? (
          <section>
            <h3>Configuration</h3>
            <SchemaFields schema={plugin.configSchema} />
          </section>
        ) : null}
        {secretFields ? (
          <section>
            <h3>Secrets</h3>
            <p>Secret values are encrypted and will not be shown again.</p>
            <SchemaFields schema={plugin.configSchema} secretMode />
          </section>
        ) : null}
        <label>
          <input type="checkbox" name="enable" /> Enable after installation
        </label>
        {m.error ? (
          <Alert tone="danger" title="Installation failed">
            The plugin could not be installed. Review the highlighted fields and permission grants.
          </Alert>
        ) : null}
        <div className="ui-dialog__actions">
          <Button type="button" variant="secondary" onClick={close} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={m.isPending} disabled={m.isPending}>
            Install plugin
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function ConfigurationDialog({
  plugin,
  close,
  api,
  refresh
}: {
  plugin: PluginRecord;
  close: () => void;
  api: ReturnType<typeof createPluginApi>;
  refresh: () => Promise<unknown>;
}) {
  const { state } = useAuth();
  const [currentGrants, setCurrentGrants] = useState(plugin.grantedPermissions);
  const q = useQuery({
    queryKey: [...key, plugin.id, "configuration"],
    queryFn: () => api.configuration(plugin.id)
  });
  const ai = useQuery({
    queryKey: [...key, plugin.id, "ai-configuration"],
    queryFn: () => api.aiConfiguration(plugin.id)
  });
  const [chatMessages, setChatMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const aiSave = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.updateAiConfiguration(plugin.id, body),
    onSuccess: () => void ai.refetch()
  });
  const aiTest = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      saveAndTestAiConfiguration(api, plugin.id, body, () => ai.refetch()),
    onSuccess: () => void ai.refetch()
  });
  const chat = useMutation({
    mutationFn: (message: string) =>
      api.chat(plugin.id, { message, conversation: chatMessages.slice(-20) }),
    onSuccess: (result, message) =>
      setChatMessages((old) => [
        ...old,
        { role: "user", content: message },
        { role: "assistant", content: result.message }
      ])
  });
  const m = useMutation({
    mutationFn: (body: {
      config: Record<string, unknown>;
      secrets: Record<string, string | null>;
    }) => api.updateConfiguration(plugin.id, body),
    onSuccess: () => close()
  });
  const grants = useMutation({
    mutationFn: ({ capability, grant }: { capability: string; grant: boolean }) => {
      const next = new Set(currentGrants);
      if (grant) next.add(capability);
      else next.delete(capability);
      return api.updateGrants(plugin.id, [...next]);
    },
    onSuccess: async (updated) => {
      setCurrentGrants(updated.grantedPermissions);
      await refresh();
    }
  });
  if (q.isLoading) return <Skeleton />;
  const schema = plugin.manifest.configSchema,
    secretKeys = Object.entries(schema?.properties ?? {})
      .filter(([, property]) => isSecretProperty(property))
      .map(([key]) => key);
  return (
    <Dialog
      open
      onCancel={close}
      onConfirm={() => undefined}
      title={`Configure ${plugin.displayName}`}
      showActions={false}
    >
      <div className="plugin-configuration-dialog">
        <CapabilityGrants
          declared={Array.from(new Set([...plugin.manifest.permissions, ...plugin.manifest.capabilities]))}
          granted={currentGrants}
          canManage={state.user?.role === "OWNER" || state.user?.role === "ADMIN"}
          {...(grants.isPending && grants.variables?.capability
            ? { pending: grants.variables.capability }
            : {})}
          onChange={(capability, grant) => grants.mutate({ capability, grant })}
        />
        {grants.isSuccess ? <Alert tone="success" title="Capability grants updated" /> : null}
        {grants.isError ? (
          <Alert tone="danger" title="Unable to update capability grants">
            Your previous grants remain unchanged.
          </Alert>
        ) : null}
        <AiProviderForm
          configuration={ai.data}
          canManage={state.user?.role === "OWNER" || state.user?.role === "ADMIN"}
          saving={aiSave.isPending}
          testing={aiTest.isPending}
          save={(body) => {
            aiTest.reset();
            aiSave.mutate(body);
          }}
          test={(body) => {
            aiSave.reset();
            aiTest.mutate(body);
          }}
          clearStatus={() => {
            aiSave.reset();
            aiTest.reset();
          }}
          saveError={aiSave.error}
          saveSucceeded={aiSave.isSuccess || aiTest.isSuccess}
          {...(aiTest.isSuccess ? { testState: "success" as const } : {})}
          testError={aiTest.error}
        />
        <TravelAiChat
          plugin={plugin}
          configuration={ai.data}
          chatMessages={chatMessages}
          chatPending={chat.isPending}
          chatError={chat.isError}
          send={(message) => chat.mutate(message)}
          llmGranted={currentGrants.includes("LLM")}
        />
        <form
          className="admin-form plugin-configuration-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form),
              secrets = valuesFromForm(form, schema, true) as Record<string, string | null>;
            for (const key of secretKeys)
              if (data.get(`clear:${key}`) !== null) secrets[key] = null;
            m.mutate({ config: valuesFromForm(form, schema, false), secrets });
          }}
        >
          <section>
            <h3>Configuration</h3>
            <SchemaFields schema={schema} values={q.data?.config} />
          </section>
          {secretKeys.length ? (
            <section>
              <h3>Secrets</h3>
              <p>Existing values are never displayed. Leave blank to keep the current value.</p>
              <SchemaFields
                schema={schema}
                values={Object.fromEntries((q.data?.secretKeys ?? []).map((key) => [key, true]))}
                secretMode
              />
              {secretKeys.map((key) => (
                <label key={key}>
                  <input type="checkbox" name={`clear:${key}`} /> Clear {key}
                </label>
              ))}
            </section>
          ) : null}
          {m.error ? (
            <Alert tone="danger" title="Unable to save configuration">
              Review the configuration fields and try again.
            </Alert>
          ) : null}
          <div className="ui-dialog__actions">
            <Button type="button" variant="secondary" onClick={close} disabled={m.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={m.isPending} disabled={m.isPending}>
              Save configuration
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function TravelAiChat({
  plugin,
  configuration,
  chatMessages,
  chatPending,
  chatError,
  send,
  llmGranted
}: {
  plugin: PluginRecord;
  configuration: PluginAiConfiguration | undefined;
  chatMessages: Array<{ role: "user" | "assistant"; content: string }>;
  chatPending: boolean;
  chatError: boolean;
  send: (message: string) => void;
  llmGranted: boolean;
}) {
  return (
    <section>
      <h3>Travel AI chat</h3>
      <p>Use this assistant for planning only. It cannot complete bookings.</p>
      {chatMessages.map((message, index) => (
        <p key={index}>
          <strong>{message.role === "user" ? "You" : "Travel AI"}:</strong> {message.content}
        </p>
      ))}
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const message = String(new FormData(form).get("message") ?? "").trim();
          if (message) {
            send(message);
            form.reset();
          }
        }}
      >
        <Input
          name="message"
          aria-label="Message"
          placeholder="Ask Travel AI"
          disabled={
            chatPending || plugin.status !== "ACTIVE" || !configuration?.configured || !llmGranted
          }
        />
        {chatError ? (
          <Alert tone="danger" title="Chat request failed">
            The assistant is unavailable. Verify configuration, grants, and plugin status.
          </Alert>
        ) : null}
        <Button
          type="submit"
          loading={chatPending}
          disabled={
            chatPending || plugin.status !== "ACTIVE" || !configuration?.configured || !llmGranted
          }
        >
          Send
        </Button>
      </form>
    </section>
  );
}
function permissionDescription(permission: string) {
  const descriptions: Record<string, string> = {
    LLM: "Use the configured language-model service.",
    MEMORY: "Read and write plugin-scoped memory.",
    EVENTS: "Publish and receive organization-scoped events.",
    TOOLS: "Register and use approved tools.",
    EMAIL: "Use the organization email adapter.",
    CALENDAR: "Use the organization calendar adapter.",
    CRM: "Use the organization CRM adapter.",
    VOICE: "Use approved voice services.",
    SEARCH: "Use the approved search adapter.",
    FILES: "Use plugin-scoped file services."
  };
  return descriptions[permission] ?? "Grants access to this scoped platform service.";
}
