"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can, useEffectivePermissions } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
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
import {
  createConnectorApi,
  type ConnectorDefinition,
  type ConnectorInstallation
} from "./connector-api";

const key = ["connectors"] as const;
function useApi() {
  const { client } = useAuth();
  return useMemo(() => createConnectorApi(client), [client]);
}

export function ConnectorsPage() {
  const api = useApi(),
    qc = useQueryClient();
  const [search, setSearch] = useState("");
  const catalogue = useQuery({ queryKey: [...key, "catalogue"], queryFn: api.catalogue });
  const installations = useQuery({
    queryKey: [...key, "installations", search],
    queryFn: () => api.list({ pageSize: 50, search })
  });
  const install = useMutation({
    mutationFn: (definition: ConnectorDefinition) =>
      api.install({
        connectorKey: definition.key,
        displayName: definition.name,
        grantedCapabilities: definition.capabilities
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key })
  });
  const installedKeys = new Set(installations.data?.items.map((item) => item.connector.key) ?? []);
  return (
    <AccessGate permission="connector.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Connectors</h1>
            <p>Securely connect AI employees to organization business systems.</p>
          </div>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="connector-search">Search installed connectors</Label>
          <Input
            id="connector-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Card>
        <h2>Installed connectors</h2>
        {installations.isLoading ? (
          <Skeleton />
        ) : installations.isError ? (
          <Alert tone="danger" title="Unable to load connectors">
            <Button onClick={() => installations.refetch()}>Retry</Button>
          </Alert>
        ) : installations.data?.items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Connector</th>
                  <th>Status</th>
                  <th>Health</th>
                  <th>Capabilities</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {installations.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.displayName}</strong>
                      <small>{item.connector.name}</small>
                    </td>
                    <td>
                      <Badge>{item.status}</Badge>
                    </td>
                    <td>
                      <Badge>{item.lastHealthStatus}</Badge>
                    </td>
                    <td>{item.grantedCapabilities.join(", ") || "None"}</td>
                    <td>
                      <Link href={`/connectors/${item.id}`}>Manage</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No installed connectors"
            description="Install one from the catalogue."
          />
        )}
        <h2>Connector catalogue</h2>
        {catalogue.isLoading ? (
          <Skeleton />
        ) : (
          <div className="admin-grid">
            {catalogue.data?.map((definition) => {
              const installed = installedKeys.has(definition.key);
              return (
                <Card key={definition.id}>
                  <h3>{definition.name}</h3>
                  <p>{definition.description}</p>
                  <Badge>{definition.category}</Badge> <Badge>{definition.version}</Badge>{" "}
                  <Badge>{definition.authType}</Badge>
                  <p>Capabilities: {definition.capabilities.join(", ")}</p>
                  {installed ? (
                    <Badge tone="success">Installed</Badge>
                  ) : (
                    <Can permission="connector.install">
                      <Button
                        loading={install.isPending}
                        disabled={install.isPending}
                        onClick={() => install.mutate(definition)}
                      >
                        Install
                      </Button>
                    </Can>
                  )}
                </Card>
              );
            })}
          </div>
        )}
        {install.isError ? <Alert tone="danger" title="Connector installation failed" /> : null}
      </section>
    </AccessGate>
  );
}

export function ConnectorDetailsPage() {
  const { id } = useParams<{ id: string }>(),
    api = useApi(),
    qc = useQueryClient(),
    router = useRouter();
  const permissions = useEffectivePermissions();
  const installation = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const tools = useQuery({ queryKey: [...key, id, "tools"], queryFn: () => api.tools(id) });
  const executions = useQuery({
    queryKey: [...key, id, "executions"],
    queryFn: () => api.executions(id)
  });
  const events = useQuery({ queryKey: [...key, id, "events"], queryFn: () => api.events(id) });
  const audit = useQuery({ queryKey: [...key, id, "audit"], queryFn: () => api.audit(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const action = useMutation({
    mutationFn: (name: "enable" | "disable" | "test" | "health" | "disconnect" | "reconnect") =>
      api[name](id),
    onSuccess: refresh
  });
  const capabilities = useMutation({
    mutationFn: api.updateCapabilities.bind(null, id),
    onSuccess: refresh
  });
  const configuration = useMutation({
    mutationFn: (value: Record<string, unknown>) => api.updateConfiguration(id, value),
    onSuccess: refresh
  });
  const credentials = useMutation({
    mutationFn: (value: Record<string, string>) => api.updateCredentials(id, value),
    onSuccess: refresh
  });
  const remove = useMutation({
    mutationFn: () => api.remove(id),
    onSuccess: () => router.push("/connectors")
  });
  if (installation.isLoading) return <Skeleton />;
  if (!installation.data)
    return <EmptyState title="Connector not found" description="It may have been archived." />;
  const item = installation.data;
  return (
    <AccessGate permission="connector.read">
      <section className="admin-page">
        <Link href="/connectors">← Connectors</Link>
        <header className="admin-page__header">
          <div>
            <h1>{item.displayName}</h1>
            <p>{item.connector.description}</p>
          </div>
          <div>
            <Badge>{item.status}</Badge> <Badge>{item.lastHealthStatus}</Badge>
          </div>
        </header>
        <Lifecycle item={item} pending={action.isPending} run={(name) => action.mutate(name)} />
        {action.isError ? <Alert tone="danger" title="Connector action failed" /> : null}
        <div className="admin-grid">
          <Card>
            <h2>Capability grants</h2>
            {permissions.has("connector.update") ? (
              item.connector.capabilities.map((capability) => {
                const checked = item.grantedCapabilities.includes(capability);
                return (
                  <label key={capability}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={capabilities.isPending}
                      onChange={() =>
                        capabilities.mutate(
                          checked
                            ? item.grantedCapabilities.filter((value) => value !== capability)
                            : [...item.grantedCapabilities, capability]
                        )
                      }
                    />{" "}
                    {capability}
                  </label>
                );
              })
            ) : (
              <p>You have read-only access to capability grants.</p>
            )}
          </Card>
          <Can permission="connector.configure">
            <ConfigurationCard item={item} save={(value) => configuration.mutate(value)} />
          </Can>
          <Can permission="connector.authenticate">
            <CredentialsCard item={item} save={(value) => credentials.mutate(value)} />
          </Can>
        </div>
        <Card>
          <h2>Tools</h2>
          {tools.data?.map((tool) => (
            <p key={tool.id}>
              <strong>{tool.displayName}</strong> — {tool.description}{" "}
              <Badge>{tool.riskLevel}</Badge>
            </p>
          ))}
        </Card>
        <div className="admin-grid">
          <History title="Executions" items={executions.data?.items ?? []} />
          <History title="Events" items={events.data?.items ?? []} />
          <History title="Audit" items={audit.data?.items ?? []} />
        </div>
        <Can permission="connector.remove">
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Archive connector
          </Button>
        </Can>
      </section>
    </AccessGate>
  );
}

function Lifecycle({
  item,
  pending,
  run
}: {
  item: ConnectorInstallation;
  pending: boolean;
  run(name: "enable" | "disable" | "test" | "health" | "disconnect" | "reconnect"): void;
}) {
  return (
    <Card className="admin-toolbar">
      {(
        [
          ["test", "connector.test"],
          ["health", "connector.health"],
          ["enable", "connector.enable"],
          ["disable", "connector.disable"],
          ["disconnect", "connector.disconnect"],
          ["reconnect", "connector.authenticate"]
        ] as const
      ).map(([name, permission]) => (
        <Can key={name} permission={permission}>
          <Button disabled={pending} loading={pending} onClick={() => run(name)}>
            {name[0]?.toUpperCase()}
            {name.slice(1)}
          </Button>
        </Can>
      ))}
      <span>
        Last checked:{" "}
        {item.lastHealthCheckedAt ? new Date(item.lastHealthCheckedAt).toLocaleString() : "Never"}
      </span>
    </Card>
  );
}
function ConfigurationCard({
  item,
  save
}: {
  item: ConnectorInstallation;
  save(value: Record<string, unknown>): void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get("configuration") ?? "{}");
    try {
      save(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      /* visible native JSON field remains */
    }
  };
  return (
    <Card>
      <h2>Configuration</h2>
      <form className="admin-form" onSubmit={submit}>
        <Label htmlFor="connector-configuration">Configuration JSON</Label>
        <textarea
          id="connector-configuration"
          name="configuration"
          className="ui-input"
          defaultValue={JSON.stringify(item.configuration, null, 2)}
        />
        <Button>Save configuration</Button>
      </form>
    </Card>
  );
}
function CredentialsCard({
  item,
  save
}: {
  item: ConnectorInstallation;
  save(value: Record<string, string>): void;
}) {
  const [token, setToken] = useState("");
  const credentialKey = item.connector.key === "hubspot-crm" ? "privateAppToken" : "token";
  return (
    <Card>
      <h2>Credentials</h2>
      <p>
        {Object.keys(item.credentialMetadata).length
          ? "Credentials configured"
          : "No credentials configured"}
      </p>
      <Label htmlFor="connector-token">
        {item.connector.key === "hubspot-crm" ? "New HubSpot private-app token" : "New token"}
      </Label>
      <Input
        id="connector-token"
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <Button
        disabled={!token.trim()}
        onClick={() => {
          save({ [credentialKey]: token });
          setToken("");
        }}
      >
        Replace credentials
      </Button>
    </Card>
  );
}
function History({ title, items }: { title: string; items: Record<string, unknown>[] }) {
  return (
    <Card>
      <h2>{title}</h2>
      {items.length ? (
        items.map((item, index) => (
          <p key={String(item.id ?? index)}>
            {String(item.event ?? item.toolName ?? item.eventType ?? item.status ?? "Record")}
          </p>
        ))
      ) : (
        <p>No records.</p>
      )}
    </Card>
  );
}
