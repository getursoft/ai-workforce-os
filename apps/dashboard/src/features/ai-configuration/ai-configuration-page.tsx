"use client";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { createAgentApi } from "../agents/agent-api";
import {
  createAiConfigurationApi,
  type AiModelProfile,
  type AiProfilePurpose,
  type AiProviderConnection,
  type AiProviderType
} from "./ai-configuration-api";

const PURPOSES: readonly AiProfilePurpose[] = [
  "DEFAULT",
  "ROUTING",
  "CONVERSATION",
  "REASONING",
  "EXTRACTION",
  "SUMMARIZATION",
  "EMBEDDING"
];

const PROVIDER_TYPES: readonly AiProviderType[] = ["OPENAI_COMPATIBLE", "AZURE_OPENAI"];

function useAiConfigApi() {
  const { client } = useAuth();
  return useMemo(() => createAiConfigurationApi(client), [client]);
}

function useEmployeesApi() {
  const { client } = useAuth();
  return useMemo(() => createAgentApi(client), [client]);
}

type Tab = "connections" | "profiles" | "assignments" | "defaults";

function Tabs({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "connections", label: "Provider Connections" },
    { id: "profiles", label: "Model Profiles" },
    { id: "assignments", label: "Employee Assignments" },
    { id: "defaults", label: "Organization Defaults" }
  ];
  return (
    <div className="admin-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === value}
          className={`admin-tabs__tab ${tab.id === value ? "admin-tabs__tab--active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function AiConfigurationPage() {
  const [tab, setTab] = useState<Tab>("connections");

  return (
    <AccessGate permission="ai.provider.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>AI Providers</h1>
            <p>
              Store an AI provider credential once per organization, build reusable model profiles
              from it, and let employees reference those profiles instead of copying API keys.
            </p>
          </div>
        </header>

        <Tabs value={tab} onChange={setTab} />

        {tab === "connections" ? <ConnectionsTab /> : null}
        {tab === "profiles" ? <ProfilesTab /> : null}
        {tab === "assignments" ? <AssignmentsTab /> : null}
        {tab === "defaults" ? <DefaultsTab /> : null}
      </section>
    </AccessGate>
  );
}

function healthTone(status: string) {
  if (status === "HEALTHY") return "success" as const;
  if (status === "DEGRADED") return "warning" as const;
  if (status === "UNHEALTHY") return "danger" as const;
  return "neutral" as const;
}

function ConnectionsTab() {
  const api = useAiConfigApi(),
    qc = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<AiProviderConnection | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; message: string } | null>(null);
  const [name, setName] = useState(""),
    [providerType, setProviderType] = useState<AiProviderType>("OPENAI_COMPATIBLE"),
    [baseUrl, setBaseUrl] = useState(""),
    [apiKey, setApiKey] = useState("");

  const connections = useQuery({ queryKey: ["ai-connections"], queryFn: api.listConnections });
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai-connections"] });

  const create = useMutation({
    mutationFn: () =>
      api.createConnection({
        name: name.trim(),
        providerType,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      }),
    onSuccess: () => {
      setName("");
      setBaseUrl("");
      setApiKey("");
      void refresh();
    }
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void refresh();
    }
  });

  const setDefault = useMutation({
    mutationFn: (id: string) => api.updateConnection(id, { isDefault: true }),
    onSuccess: () => void refresh()
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testConnection(id),
    onSuccess: (result, id) => {
      setTestResult({
        id,
        message:
          result.status === "HEALTHY"
            ? `Healthy — ${result.latencyMs}ms`
            : `${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}`
      });
      void refresh();
    },
    onError: (_error, id) => setTestResult({ id, message: "Test failed" })
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };

  return (
    <>
      <Can permission="ai.provider.manage">
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="connection-name">Connection name</Label>
          <Input
            id="connection-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. OpenAI Production"
          />
          <Label htmlFor="connection-provider-type">Provider type</Label>
          <select
            className="ui-input"
            id="connection-provider-type"
            value={providerType}
            onChange={(event) => setProviderType(event.target.value as AiProviderType)}
          >
            {PROVIDER_TYPES.map((value) => (
              <option key={value} value={value}>
                {value === "OPENAI_COMPATIBLE" ? "OpenAI-compatible" : "Azure OpenAI"}
              </option>
            ))}
          </select>
          <Label htmlFor="connection-base-url">
            {providerType === "AZURE_OPENAI" ? "Endpoint" : "Base URL"}
          </Label>
          <Input
            id="connection-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={
              providerType === "AZURE_OPENAI"
                ? "https://your-resource.openai.azure.com"
                : "https://api.openai.com/v1"
            }
          />
          <Label htmlFor="connection-api-key">API key</Label>
          <Input
            id="connection-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Entered once — never shown again after saving"
          />
          <Button loading={create.isPending} disabled={create.isPending}>
            Add connection
          </Button>
        </form>
        {create.isError ? (
          <Alert tone="danger" title="Could not create connection">
            Check the provider type, URL, and credential, then try again.
          </Alert>
        ) : null}
      </Can>

      {connections.isLoading ? (
        <Skeleton />
      ) : connections.isError ? (
        <Alert tone="danger" title="Unable to load provider connections" />
      ) : connections.data?.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider</th>
                <th>Base URL</th>
                <th>Credential</th>
                <th>Health</th>
                <th>Profiles</th>
                <th>Default</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.data.map((connection) => (
                <tr key={connection.id}>
                  <td>
                    <strong>{connection.name}</strong>
                  </td>
                  <td>{connection.providerType}</td>
                  <td>{connection.baseUrl ?? "—"}</td>
                  <td>
                    <Badge tone={connection.credentialConfigured ? "success" : "neutral"}>
                      {connection.credentialConfigured ? "Configured" : "Not configured"}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={healthTone(connection.lastHealthStatus)}>
                      {connection.lastHealthStatus}
                    </Badge>
                    {testResult?.id === connection.id ? (
                      <div>
                        <small>{testResult.message}</small>
                      </div>
                    ) : null}
                  </td>
                  <td>{connection.modelProfileCount}</td>
                  <td>{connection.isDefault ? <Badge tone="success">Default</Badge> : null}</td>
                  <td>
                    <Can permission="ai.provider.manage">
                      <Button
                        variant="secondary"
                        loading={test.isPending && test.variables === connection.id}
                        onClick={() => test.mutate(connection.id)}
                      >
                        Test Connection
                      </Button>
                      {!connection.isDefault ? (
                        <Button variant="secondary" onClick={() => setDefault.mutate(connection.id)}>
                          Set Default
                        </Button>
                      ) : null}
                      <Button variant="danger" onClick={() => setDeleteTarget(connection)}>
                        Delete
                      </Button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No provider connections yet"
          description="Add one connection per provider credential — every model profile you create can reuse it."
        />
      )}

      <Dialog
        open={Boolean(deleteTarget)}
        title="Delete provider connection?"
        description={
          deleteTarget && deleteTarget.modelProfileCount > 0
            ? `${deleteTarget.name} has ${deleteTarget.modelProfileCount} model profile(s) referencing it — remove or reassign those first.`
            : "This connection's credential will be permanently deleted."
        }
        destructive
        confirmLabel="Delete connection"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => (deleteTarget ? remove.mutateAsync(deleteTarget.id) : undefined)}
      />
    </>
  );
}

function ProfilesTab() {
  const api = useAiConfigApi(),
    qc = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<AiModelProfile | null>(null);
  const [name, setName] = useState(""),
    [providerConnectionId, setProviderConnectionId] = useState(""),
    [purpose, setPurpose] = useState<AiProfilePurpose>("DEFAULT"),
    [model, setModel] = useState(""),
    [embeddingModel, setEmbeddingModel] = useState(""),
    [isDefault, setIsDefault] = useState(false);

  const connections = useQuery({ queryKey: ["ai-connections"], queryFn: api.listConnections });
  const profiles = useQuery({ queryKey: ["ai-profiles"], queryFn: () => api.listProfiles() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai-profiles"] });

  const create = useMutation({
    mutationFn: () =>
      api.createProfile({
        name: name.trim(),
        providerConnectionId,
        purpose,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(embeddingModel.trim() ? { embeddingModel: embeddingModel.trim() } : {}),
        isDefault
      }),
    onSuccess: () => {
      setName("");
      setModel("");
      setEmbeddingModel("");
      setIsDefault(false);
      void refresh();
    }
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void refresh();
    }
  });

  const toggleActive = useMutation({
    mutationFn: (profile: AiModelProfile) => api.updateProfile(profile.id, { isActive: !profile.isActive }),
    onSuccess: () => void refresh()
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() && providerConnectionId && !create.isPending) create.mutate();
  };

  const connectionName = (id: string) => connections.data?.find((c) => c.id === id)?.name ?? id;

  return (
    <>
      <Can permission="ai.profile.manage">
        <form className="admin-form" onSubmit={submit}>
          <Label htmlFor="profile-name">Profile name</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Standard GPT-4.1"
          />
          <Label htmlFor="profile-connection">Provider connection</Label>
          <select
            className="ui-input"
            id="profile-connection"
            value={providerConnectionId}
            onChange={(event) => setProviderConnectionId(event.target.value)}
          >
            <option value="">Select a connection…</option>
            {connections.data?.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
          <Label htmlFor="profile-purpose">Purpose</Label>
          <select
            className="ui-input"
            id="profile-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as AiProfilePurpose)}
          >
            {PURPOSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <Label htmlFor="profile-model">Model</Label>
          <Input
            id="profile-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="e.g. gpt-4.1"
          />
          <Label htmlFor="profile-embedding-model">Embedding model (if applicable)</Label>
          <Input
            id="profile-embedding-model"
            value={embeddingModel}
            onChange={(event) => setEmbeddingModel(event.target.value)}
            placeholder="e.g. text-embedding-3-small"
          />
          <Label htmlFor="profile-is-default">
            <input
              id="profile-is-default"
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />{" "}
            Default profile for this purpose
          </Label>
          <Button loading={create.isPending} disabled={create.isPending || !providerConnectionId}>
            Add profile
          </Button>
        </form>
        {create.isError ? (
          <Alert tone="danger" title="Could not create profile">
            Check that the selected connection still exists.
          </Alert>
        ) : null}
      </Can>

      {profiles.isLoading ? (
        <Skeleton />
      ) : profiles.isError ? (
        <Alert tone="danger" title="Unable to load model profiles" />
      ) : profiles.data?.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Connection</th>
                <th>Purpose</th>
                <th>Model</th>
                <th>Default</th>
                <th>Active</th>
                <th>Assignments</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.map((profile) => (
                <tr key={profile.id}>
                  <td>
                    <strong>{profile.name}</strong>
                  </td>
                  <td>{connectionName(profile.providerConnectionId)}</td>
                  <td>
                    <Badge>{profile.purpose}</Badge>
                  </td>
                  <td>{profile.model ?? profile.embeddingModel ?? "—"}</td>
                  <td>{profile.isDefault ? <Badge tone="success">Default</Badge> : null}</td>
                  <td>
                    <Badge tone={profile.isActive ? "success" : "neutral"}>
                      {profile.isActive ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td>{profile._count?.employeeAssignments ?? 0}</td>
                  <td>
                    <Can permission="ai.profile.manage">
                      <Button variant="secondary" onClick={() => toggleActive.mutate(profile)}>
                        {profile.isActive ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="danger" onClick={() => setDeleteTarget(profile)}>
                        Delete
                      </Button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No model profiles yet"
          description="Create a profile (model + purpose + settings) from one of your provider connections."
        />
      )}

      <Dialog
        open={Boolean(deleteTarget)}
        title="Delete model profile?"
        description={
          deleteTarget && (deleteTarget._count?.employeeAssignments ?? 0) > 0
            ? `${deleteTarget.name} is assigned to ${deleteTarget._count?.employeeAssignments} employee(s) — reassign those first, or disable the profile instead of deleting it.`
            : "This profile will be permanently deleted."
        }
        destructive
        confirmLabel="Delete profile"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => (deleteTarget ? remove.mutateAsync(deleteTarget.id) : undefined)}
      />
    </>
  );
}

function AssignmentsTab() {
  const api = useAiConfigApi(),
    employeesApi = useEmployeesApi(),
    qc = useQueryClient();
  const [employeeId, setEmployeeId] = useState("");
  const [purpose, setPurpose] = useState<AiProfilePurpose>("DEFAULT");
  const [modelProfileId, setModelProfileId] = useState("");

  const employees = useQuery({ queryKey: ["agents"], queryFn: employeesApi.employees });
  const profiles = useQuery({ queryKey: ["ai-profiles"], queryFn: () => api.listProfiles() });
  const assignments = useQuery({
    queryKey: ["ai-assignments", employeeId],
    queryFn: () => api.listAssignments(employeeId),
    enabled: Boolean(employeeId)
  });

  const upsert = useMutation({
    mutationFn: () => api.upsertAssignment(employeeId, { modelProfileId, purpose }),
    onSuccess: () => {
      setModelProfileId("");
      void qc.invalidateQueries({ queryKey: ["ai-assignments", employeeId] });
    }
  });

  const remove = useMutation({
    mutationFn: (assignmentPurpose: AiProfilePurpose) => api.removeAssignment(employeeId, assignmentPurpose),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ai-assignments", employeeId] })
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (employeeId && modelProfileId && !upsert.isPending) upsert.mutate();
  };

  const profileName = (id: string) => profiles.data?.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <div className="admin-toolbar">
        <Label htmlFor="assignment-employee">Employee</Label>
        <select
          className="ui-input"
          id="assignment-employee"
          value={employeeId}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">Select an employee…</option>
          {employees.data?.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.displayName}
            </option>
          ))}
        </select>
      </div>

      {!employeeId ? (
        <EmptyState
          title="Choose an employee"
          description="Assignments override that employee's organization defaults for the selected purpose. No assignment at all means the employee inherits the organization default."
        />
      ) : (
        <>
          <Can permission="ai.assignment.manage">
            <form className="admin-form" onSubmit={submit}>
              <Label htmlFor="assignment-purpose">Purpose</Label>
              <select
                className="ui-input"
                id="assignment-purpose"
                value={purpose}
                onChange={(event) => setPurpose(event.target.value as AiProfilePurpose)}
              >
                {PURPOSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <Label htmlFor="assignment-profile">Model profile</Label>
              <select
                className="ui-input"
                id="assignment-profile"
                value={modelProfileId}
                onChange={(event) => setModelProfileId(event.target.value)}
              >
                <option value="">Select a profile…</option>
                {profiles.data?.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.purpose})
                  </option>
                ))}
              </select>
              <Button loading={upsert.isPending} disabled={upsert.isPending || !modelProfileId}>
                Assign
              </Button>
            </form>
          </Can>

          {assignments.isLoading ? (
            <Skeleton />
          ) : assignments.data?.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Purpose</th>
                    <th>Model profile</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.data.map((assignment) => (
                    <tr key={assignment.id}>
                      <td>
                        <Badge>{assignment.purpose}</Badge>
                      </td>
                      <td>{profileName(assignment.modelProfileId)}</td>
                      <td>
                        <Can permission="ai.assignment.manage">
                          <Button variant="danger" onClick={() => remove.mutate(assignment.purpose)}>
                            Remove override
                          </Button>
                        </Can>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No overrides for this employee"
              description="It fully inherits organization defaults for every purpose."
            />
          )}
        </>
      )}
    </>
  );
}

const DEFAULT_FIELDS: Array<{ key: "defaultProfileId" | "routingProfileId" | "reasoningProfileId" | "embeddingProfileId"; label: string; purpose: AiProfilePurpose | null }> = [
  { key: "defaultProfileId", label: "Organization Default", purpose: null },
  { key: "routingProfileId", label: "Routing Default", purpose: "ROUTING" },
  { key: "reasoningProfileId", label: "Reasoning Default", purpose: "REASONING" },
  { key: "embeddingProfileId", label: "Embedding Default", purpose: "EMBEDDING" }
];

function DefaultsTab() {
  const api = useAiConfigApi(),
    qc = useQueryClient();
  const defaults = useQuery({ queryKey: ["ai-org-defaults"], queryFn: api.getOrganizationDefaults });
  const profiles = useQuery({ queryKey: ["ai-profiles"], queryFn: () => api.listProfiles() });
  const [pending, setPending] = useState<Record<string, string>>({});

  const update = useMutation({
    mutationFn: (body: Record<string, string | null>) => api.updateOrganizationDefaults(body),
    onSuccess: () => {
      setPending({});
      void qc.invalidateQueries({ queryKey: ["ai-org-defaults"] });
    }
  });

  if (defaults.isLoading) return <Skeleton />;
  if (defaults.isError) return <Alert tone="danger" title="Unable to load organization defaults" />;

  const currentValue = (key: string) => pending[key] ?? (defaults.data as unknown as Record<string, string | null>)?.[key] ?? "";

  return (
    <div className="admin-form">
      <p>
        Employees with no explicit assignment inherit these defaults. Changing a default here
        immediately changes what every inheriting employee uses — no need to re-enter the API key.
      </p>
      {DEFAULT_FIELDS.map((field) => (
        <div key={field.key}>
          <Label htmlFor={`default-${field.key}`}>{field.label}</Label>
          <select
            className="ui-input"
            id={`default-${field.key}`}
            value={currentValue(field.key)}
            onChange={(event) => setPending((current) => ({ ...current, [field.key]: event.target.value }))}
          >
            <option value="">None</option>
            {(field.purpose ? profiles.data?.filter((p) => p.purpose === field.purpose) : profiles.data)?.map(
              (profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              )
            )}
          </select>
        </div>
      ))}
      <Can permission="ai.assignment.manage">
        <Button
          loading={update.isPending}
          disabled={update.isPending || Object.keys(pending).length === 0}
          onClick={() =>
            update.mutate(
              Object.fromEntries(Object.entries(pending).map(([key, value]) => [key, value || null]))
            )
          }
        >
          Save defaults
        </Button>
      </Can>
    </div>
  );
}
