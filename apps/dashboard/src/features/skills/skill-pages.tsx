"use client";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { Can, useEffectivePermissions } from "../admin/authorization";
import { createAgentApi, type AgentEmployee } from "../agents/agent-api";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Skeleton
} from "../../components/ui";
import {
  createSkillApi,
  type EmployeeSkillGrant,
  type SkillInstallation,
  type SkillMarketplaceItem,
  type SkillSearchResult
} from "./skill-api";
import { PacksTab } from "./skill-packs";
import { TemplatesTab } from "./skill-templates";
import { PipelinesTab } from "./skill-pipelines";
import { AnalyticsTab } from "./skill-analytics";

export const queryKey = ["skills"] as const;

export function useApi() {
  const { client } = useAuth();
  return useMemo(() => createSkillApi(client), [client]);
}

export function useAgentApi() {
  const { client } = useAuth();
  return useMemo(() => createAgentApi(client), [client]);
}

type TabId = "MARKETPLACE" | "INSTALLED" | "GRANTS" | "EXECUTIONS" | "HEALTH" | "PACKS" | "TEMPLATES" | "PIPELINES" | "ANALYTICS";

const TABS: ReadonlyArray<{ id: TabId; label: string; permission: string }> = [
  { id: "MARKETPLACE", label: "Marketplace", permission: "skill.marketplace.read" },
  { id: "INSTALLED", label: "Installed", permission: "skill.marketplace.read" },
  { id: "GRANTS", label: "Employee Grants", permission: "skill.grant.manage" },
  { id: "EXECUTIONS", label: "Executions", permission: "skill.execution.read" },
  { id: "HEALTH", label: "Health", permission: "skill.health.read" },
  { id: "PACKS", label: "Packs", permission: "skill.marketplace.read" },
  { id: "TEMPLATES", label: "Templates", permission: "skill.marketplace.read" },
  { id: "PIPELINES", label: "Pipelines", permission: "skill.marketplace.read" },
  { id: "ANALYTICS", label: "Analytics", permission: "skill.execution.read" }
];

export function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "COMPLETED" || status === "HEALTHY" || status === "ENABLED" || status === "INSTALLED") return "success";
  if (status === "FAILED" || status === "UNHEALTHY" || status === "TIMEOUT") return "danger";
  if (status === "DEGRADED" || status === "RUNNING" || status === "QUEUED" || status === "DISABLED") return "warning";
  return "neutral";
}

export function SkillsPage() {
  const permissions = useEffectivePermissions();
  const [activeTab, setActiveTab] = useState<TabId>("MARKETPLACE");
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null);

  const availableTabs = TABS.filter((tab) => permissions.has(tab.permission));

  return (
    <section className="admin-page">
      <PageHeader title="Skills" description="Install versioned skills and grant them to AI employees." />
      <Card className="admin-toolbar" style={{ padding: "6px" }}>
        <div className="admin-tabs">
          {availableTabs.map((tab) => (
            <button
              key={tab.id}
              className={`admin-tab ${activeTab === tab.id ? "admin-tab--active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </Card>

      {activeTab === "MARKETPLACE" ? (
        <MarketplaceTab />
      ) : activeTab === "PACKS" ? (
        <PacksTab />
      ) : activeTab === "TEMPLATES" ? (
        <TemplatesTab />
      ) : activeTab === "PIPELINES" ? (
        <PipelinesTab />
      ) : activeTab === "ANALYTICS" ? (
        <AnalyticsTab />
      ) : (
        <div className="admin-grid" style={{ gridTemplateColumns: "340px 1fr", alignItems: "start" }}>
          <InstallationList selectedId={selectedInstallationId} onSelect={setSelectedInstallationId} />
          <ManagePanel activeTab={activeTab} selectedId={selectedInstallationId} />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ marketplace

function MarketplaceTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [installTarget, setInstallTarget] = useState<SkillMarketplaceItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);

  const marketplace = useQuery({ queryKey: [...queryKey, "marketplace"], queryFn: api.marketplace });

  const filtersActive = Boolean(searchQuery.trim() || categoryFilter || industryFilter || installedOnly);
  const search = useQuery({
    queryKey: [...queryKey, "search", searchQuery, categoryFilter, industryFilter, installedOnly],
    queryFn: () =>
      api.search({
        ...(searchQuery.trim() ? { query: searchQuery.trim() } : {}),
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(industryFilter.trim() ? { industry: industryFilter.trim() } : {}),
        ...(installedOnly ? { installed: true } : {})
      }),
    enabled: filtersActive
  });

  const categories = Array.from(new Set((marketplace.data?.items ?? []).map((item) => item.category))).sort();

  const openInstallFromSearch = (result: SkillSearchResult) => {
    const match = marketplace.data?.items.find((item) => item.key === result.key);
    setInstallTarget(
      match ?? {
        id: result.key,
        key: result.key,
        name: result.name,
        description: result.description,
        category: result.category,
        author: result.author,
        icon: null,
        visibility: "PUBLIC",
        latestVersion: "",
        versions: [],
        installedVersions: [],
        installed: result.installed
      }
    );
  };

  const install = useMutation({
    mutationFn: (input: {
      skillKey: string;
      versionConstraint: string;
      configuration: string;
      approveSensitivePermissions: boolean;
    }) =>
      api.install({
        skillKey: input.skillKey,
        ...(input.versionConstraint.trim() ? { versionConstraint: input.versionConstraint.trim() } : {}),
        ...(input.configuration.trim() ? { configuration: JSON.parse(input.configuration) } : {}),
        approveSensitivePermissions: input.approveSensitivePermissions
      }),
    onSuccess: () => {
      setInstallTarget(null);
      void qc.invalidateQueries({ queryKey });
    }
  });

  return (
    <>
      <Card className="admin-toolbar">
        <Label htmlFor="skill-search-query">Search</Label>
        <Input
          id="skill-search-query"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Name, capability, tag…"
        />
        <Label htmlFor="skill-search-category">Category</Label>
        <select
          id="skill-search-category"
          className="ui-input"
          value={categoryFilter}
          onChange={(event) => setCategoryFilter(event.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <Label htmlFor="skill-search-industry">Industry</Label>
        <Input
          id="skill-search-industry"
          value={industryFilter}
          onChange={(event) => setIndustryFilter(event.target.value)}
          placeholder="e.g. finance"
        />
      </Card>
      <div className="admin-actions">
        <label>
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={(event) => setInstalledOnly(event.target.checked)}
          />{" "}
          Installed only
        </label>
        {filtersActive ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSearchQuery("");
              setCategoryFilter("");
              setIndustryFilter("");
              setInstalledOnly(false);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {filtersActive ? (
        search.isLoading ? (
          <Skeleton />
        ) : search.isError ? (
          <Alert tone="danger" title="Unable to search the marketplace">
            <Button onClick={() => search.refetch()}>Retry</Button>
          </Alert>
        ) : search.data?.length ? (
          <div className="admin-grid">
            {search.data.map((result) => (
              <div key={result.key} className="admin-grid-card">
                <div>
                  <h3>{result.name}</h3>
                  <p>{result.description}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{result.category}</Badge>
                  {result.industry.map((industry) => (
                    <Badge key={industry}>{industry}</Badge>
                  ))}
                  {result.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  By {result.author}
                </p>
                {result.installed ? (
                  <Badge tone="success">Installed</Badge>
                ) : (
                  <Can permission="skill.install">
                    <Button onClick={() => openInstallFromSearch(result)}>Install</Button>
                  </Can>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No matching skills" description="Try a different search term or clear the filters." />
        )
      ) : marketplace.isLoading ? (
        <Skeleton />
      ) : marketplace.isError ? (
        <Alert tone="danger" title="Unable to load the skills marketplace">
          <Button onClick={() => marketplace.refetch()}>Retry</Button>
        </Alert>
      ) : marketplace.data?.items.length ? (
        <div className="admin-grid">
          {marketplace.data.items.map((item) => (
            <div key={item.id} className="admin-grid-card">
              <div>
                <h3>
                  {item.icon ? `${item.icon} ` : ""}
                  {item.name}
                </h3>
                <p>{item.description}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge>{item.category}</Badge>
                <Badge>v{item.latestVersion}</Badge>
                <Badge>{item.visibility}</Badge>
              </div>
              <p className="text-sm" style={{ color: "var(--muted)" }}>By {item.author}</p>
              {item.installed ? (
                <Badge tone="success">
                  Installed ({item.installedVersions.join(", ")})
                </Badge>
              ) : (
                <Can permission="skill.install">
                  <Button onClick={() => setInstallTarget(item)}>Install</Button>
                </Can>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="No skills available" description="No skills have been published to the marketplace yet." />
      )}
      {install.isError ? (
        <Alert tone="danger" title="Skill installation failed">
          {install.error instanceof Error ? install.error.message : null}
        </Alert>
      ) : null}

      <Dialog
        open={installTarget !== null}
        title={installTarget ? `Install ${installTarget.name}` : "Install skill"}
        description="Optionally pin a version and supply initial configuration as JSON."
        confirmLabel="Install"
        onCancel={() => setInstallTarget(null)}
        onConfirm={() => {
          const form = document.getElementById("skill-install-form") as HTMLFormElement | null;
          form?.requestSubmit();
        }}
      >
        {installTarget ? (
          <form
            id="skill-install-form"
            className="admin-form"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              install.mutate({
                skillKey: installTarget.key,
                versionConstraint: String(data.get("versionConstraint") ?? ""),
                configuration: String(data.get("configuration") ?? ""),
                approveSensitivePermissions: data.get("approveSensitivePermissions") === "on"
              });
            }}
          >
            <Label htmlFor="skill-version-constraint">Version constraint (optional)</Label>
            <Input
              id="skill-version-constraint"
              name="versionConstraint"
              placeholder={`Latest: ${installTarget.latestVersion}`}
            />
            <Label htmlFor="skill-configuration">Configuration JSON (optional)</Label>
            <textarea id="skill-configuration" name="configuration" className="ui-input" rows={5} defaultValue="{}" />
            <label>
              <input type="checkbox" name="approveSensitivePermissions" />{" "}
              I approve any sensitive permissions this skill requests
            </label>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ installation list (shared selector)

function InstallationList({
  selectedId,
  onSelect
}: Readonly<{ selectedId: string | null; onSelect(id: string): void }>) {
  const api = useApi();
  const installations = useQuery({ queryKey: [...queryKey, "installations"], queryFn: api.installations });

  if (installations.isLoading) return <Skeleton />;
  if (installations.isError)
    return (
      <Alert tone="danger" title="Unable to load installations">
        <Button onClick={() => installations.refetch()}>Retry</Button>
      </Alert>
    );
  if (!installations.data?.length)
    return <EmptyState title="No skills installed" description="Install a skill from the Marketplace tab first." />;

  return (
    <Card>
      <h2>Installations</h2>
      <div style={{ display: "grid", gap: 8 }}>
        {installations.data.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            style={{
              textAlign: "left",
              display: "grid",
              gap: 4,
              padding: 10,
              borderRadius: 10,
              border: `1px solid ${selectedId === item.id ? "var(--primary)" : "var(--border)"}`,
              background: selectedId === item.id ? "var(--primary-soft, rgba(99,102,241,0.08))" : "transparent",
              cursor: "pointer"
            }}
          >
            <strong>{item.skillVersion.skill.name}</strong>
            <div className="flex flex-wrap gap-1.5">
              <Badge>v{item.skillVersion.version}</Badge>
              <Badge tone={statusTone(item.status)}>{item.status}</Badge>
              <Badge tone={item.enabled ? "success" : "neutral"}>{item.enabled ? "Enabled" : "Disabled"}</Badge>
            </div>
            <small style={{ color: "var(--muted)" }}>
              {item._count.grants} grant{item._count.grants === 1 ? "" : "s"} · {item._count.executions} execution
              {item._count.executions === 1 ? "" : "s"}
            </small>
          </button>
        ))}
      </div>
    </Card>
  );
}

function useSelectedInstallation(selectedId: string | null) {
  const api = useApi();
  const installations = useQuery({ queryKey: [...queryKey, "installations"], queryFn: api.installations });
  const selected: SkillInstallation | undefined = installations.data?.find((item) => item.id === selectedId);
  return { installations, selected };
}

// ------------------------------------------------------------------ manage panel (per-tab, per-selected-installation)

function ManagePanel({ activeTab, selectedId }: Readonly<{ activeTab: TabId; selectedId: string | null }>) {
  const { installations, selected } = useSelectedInstallation(selectedId);

  if (installations.isLoading) return <Skeleton />;
  if (!selectedId || !selected) {
    return <EmptyState title="Select an installation" description="Choose an installed skill from the list to manage it." />;
  }
  if (activeTab === "INSTALLED") return <InstalledDetail installation={selected} />;
  if (activeTab === "GRANTS") return <GrantsPanel installationId={selected.id} />;
  if (activeTab === "EXECUTIONS") return <ExecutionsPanel installationId={selected.id} />;
  return <HealthPanel installationId={selected.id} />;
}

// ------------------------------------------------------------------ installed detail

function InstalledDetail({ installation }: Readonly<{ installation: SkillInstallation }>) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey });

  const toggleEnabled = useMutation({
    mutationFn: () => (installation.enabled ? api.disable(installation.id) : api.enable(installation.id)),
    onSuccess: refresh
  });
  const configure = useMutation({
    mutationFn: (configuration: Record<string, unknown>) => api.configure(installation.id, configuration),
    onSuccess: refresh
  });
  const updateVersion = useMutation({
    mutationFn: (versionConstraint: string) => api.updateVersion(installation.id, versionConstraint),
    onSuccess: refresh
  });
  const rollback = useMutation({
    mutationFn: () => api.rollback(installation.id),
    onSuccess: refresh
  });
  const uninstall = useMutation({
    mutationFn: () => api.uninstall(installation.id),
    onSuccess: () => {
      setConfirmUninstall(false);
      refresh();
    }
  });

  const submitConfiguration = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get("configuration") ?? "{}");
    try {
      configure.mutate(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      /* invalid JSON stays visible in the textarea for correction */
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div className="admin-section-header">
          <div>
            <h2>{installation.skillVersion.skill.name}</h2>
            <p>{installation.skillVersion.skill.description}</p>
          </div>
          <div>
            <Badge tone={statusTone(installation.status)}>{installation.status}</Badge>{" "}
            <Badge tone={installation.enabled ? "success" : "neutral"}>
              {installation.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        </div>
        <div className="admin-details">
          <dt>Version</dt>
          <dd>{installation.skillVersion.version}</dd>
          <dt>Category</dt>
          <dd>{installation.skillVersion.skill.category}</dd>
          <dt>Author</dt>
          <dd>{installation.skillVersion.skill.author}</dd>
          <dt>Installed</dt>
          <dd>{new Date(installation.installedAt).toLocaleString()}</dd>
        </div>
        <div className="admin-actions" style={{ marginTop: 12 }}>
          <Can permission="skill.update">
            <Button loading={toggleEnabled.isPending} onClick={() => toggleEnabled.mutate()}>
              {installation.enabled ? "Disable" : "Enable"}
            </Button>
          </Can>
          <Can permission="skill.update">
            <Button
              variant="secondary"
              loading={updateVersion.isPending}
              onClick={() => {
                const versionConstraint = window.prompt("New version constraint (e.g. ^1.2.0 or an exact version):");
                if (versionConstraint?.trim()) updateVersion.mutate(versionConstraint.trim());
              }}
            >
              Update version
            </Button>
          </Can>
          <Can permission="skill.update">
            <Button
              variant="secondary"
              loading={rollback.isPending}
              onClick={() => {
                if (window.confirm("Roll back this skill installation to its previous version?")) rollback.mutate();
              }}
            >
              Rollback
            </Button>
          </Can>
          <Can permission="skill.uninstall">
            <Button variant="danger" onClick={() => setConfirmUninstall(true)}>
              Uninstall
            </Button>
          </Can>
        </div>
        {toggleEnabled.isError || updateVersion.isError || rollback.isError ? (
          <Alert tone="danger" title="Action failed" />
        ) : null}
      </Card>

      <Card>
        <h2>Dependencies</h2>
        {installation.skillVersion.dependencies.length ? (
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {installation.skillVersion.dependencies.map((dependency) => (
              <li key={dependency.id}>
                {dependency.dependencySkillKey} {dependency.versionConstraint}{" "}
                {dependency.required ? <Badge tone="warning">Required</Badge> : <Badge>Optional</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "var(--muted)" }}>No declared dependencies.</p>
        )}
      </Card>

      <Can permission="skill.configure">
        <Card>
          <h2>Configuration</h2>
          <form className="admin-form" onSubmit={submitConfiguration}>
            <Label htmlFor="skill-configuration-editor">Configuration JSON</Label>
            <textarea
              id="skill-configuration-editor"
              name="configuration"
              className="ui-input"
              rows={8}
              defaultValue={JSON.stringify(installation.configurationJson, null, 2)}
            />
            <Button loading={configure.isPending}>Save configuration</Button>
          </form>
          {configure.isError ? <Alert tone="danger" title="Invalid configuration or save failed" /> : null}
        </Card>
      </Can>

      <Dialog
        open={confirmUninstall}
        title="Uninstall this skill?"
        description="This removes the installation, revokes every employee grant, and cannot be undone."
        confirmLabel="Uninstall"
        destructive
        onCancel={() => setConfirmUninstall(false)}
        onConfirm={() => uninstall.mutate()}
      />
    </div>
  );
}

// ------------------------------------------------------------------ grants

function GrantsPanel({ installationId }: Readonly<{ installationId: string }>) {
  const api = useApi();
  const agentApi = useAgentApi();
  const qc = useQueryClient();
  const [pickerEmployeeId, setPickerEmployeeId] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<EmployeeSkillGrant | null>(null);

  const grants = useQuery({
    queryKey: [...queryKey, installationId, "grants"],
    queryFn: () => api.listGrants(installationId)
  });
  const employees = useQuery({ queryKey: ["agents", "employees"], queryFn: agentApi.employees });

  const refresh = () => qc.invalidateQueries({ queryKey: [...queryKey, installationId, "grants"] });

  const grant = useMutation({
    mutationFn: (pluginInstallationId: string) => api.grant(installationId, pluginInstallationId),
    onSuccess: () => {
      setPickerEmployeeId("");
      refresh();
    }
  });
  const setEnabled = useMutation({
    mutationFn: (input: { employeeId: string; enabled: boolean }) =>
      api.setGrantEnabled(installationId, input.employeeId, input.enabled),
    onSuccess: refresh
  });
  const revoke = useMutation({
    mutationFn: (employeeId: string) => api.revokeGrant(installationId, employeeId),
    onSuccess: () => {
      setRevokeTarget(null);
      refresh();
    }
  });

  const grantedIds = new Set((grants.data ?? []).map((item) => item.pluginInstallationId));
  const ungranted: AgentEmployee[] = (employees.data ?? []).filter((employee) => !grantedIds.has(employee.id));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Can permission="skill.grant.manage">
        <Card>
          <h2>Grant to an employee</h2>
          {employees.isLoading ? (
            <Skeleton />
          ) : ungranted.length ? (
            <div className="admin-actions">
              <select
                className="ui-input"
                value={pickerEmployeeId}
                onChange={(event) => setPickerEmployeeId(event.target.value)}
              >
                <option value="">Select an AI employee…</option>
                {ungranted.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.displayName}
                  </option>
                ))}
              </select>
              <Button
                disabled={!pickerEmployeeId}
                loading={grant.isPending}
                onClick={() => grant.mutate(pickerEmployeeId)}
              >
                Grant
              </Button>
            </div>
          ) : (
            <p style={{ color: "var(--muted)" }}>Every installed employee already has this skill granted.</p>
          )}
          {grant.isError ? <Alert tone="danger" title="Grant failed" /> : null}
        </Card>
      </Can>

      <Card>
        <h2>Granted employees</h2>
        {grants.isLoading ? (
          <Skeleton />
        ) : grants.isError ? (
          <Alert tone="danger" title="Unable to load grants">
            <Button onClick={() => grants.refetch()}>Retry</Button>
          </Alert>
        ) : grants.data?.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Granted</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {grants.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.pluginInstallation.displayName}</strong>
                      <small>{item.pluginInstallation.slug}</small>
                    </td>
                    <td>
                      <Badge tone={item.enabled ? "success" : "neutral"}>
                        {item.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </td>
                    <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="admin-actions">
                        <Can permission="skill.grant.manage">
                          <Button
                            variant="ghost"
                            loading={setEnabled.isPending}
                            onClick={() =>
                              setEnabled.mutate({ employeeId: item.pluginInstallationId, enabled: !item.enabled })
                            }
                          >
                            {item.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button variant="danger" onClick={() => setRevokeTarget(item)}>
                            Revoke
                          </Button>
                        </Can>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No grants yet" description="Grant this skill to an installed AI employee above." />
        )}
      </Card>

      <Dialog
        open={revokeTarget !== null}
        title="Revoke this grant?"
        {...(revokeTarget
          ? {
              description: `${revokeTarget.pluginInstallation.displayName} will immediately lose access to this skill.`
            }
          : {})}
        confirmLabel="Revoke"
        destructive
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) revoke.mutate(revokeTarget.pluginInstallationId);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ executions

function ExecutionsPanel({ installationId }: Readonly<{ installationId: string }>) {
  const api = useApi();
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const executions = useQuery({
    queryKey: [...queryKey, installationId, "executions", page],
    queryFn: () => api.executions(installationId, page, pageSize)
  });

  const total = executions.data?.total ?? 0;
  const hasNext = page * pageSize < total;

  return (
    <Card>
      <h2>Executions</h2>
      {executions.isLoading ? (
        <Skeleton />
      ) : executions.isError ? (
        <Alert tone="danger" title="Unable to load executions">
          <Button onClick={() => executions.refetch()}>Retry</Button>
        </Alert>
      ) : executions.data?.items.length ? (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Tokens</th>
                  <th>Credits</th>
                  <th>Retries</th>
                  <th>Error</th>
                  <th>Started</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {executions.data.items.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    </td>
                    <td>{run.durationMs} ms</td>
                    <td>
                      {run.totalTokens} <small>({run.inputTokens} in / {run.outputTokens} out)</small>
                    </td>
                    <td>{run.creditsConsumed}</td>
                    <td>{run.retryCount}</td>
                    <td>
                      {run.errorCode ? (
                        <span title={run.errorMessageSafe ?? undefined}>
                          <Badge tone="danger">{run.errorCode}</Badge>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
                    <td>{run.completedAt ? new Date(run.completedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-actions" style={{ marginTop: 12 }}>
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              Previous
            </Button>
            <span>
              Page {page} · {total} total
            </span>
            <Button variant="secondary" disabled={!hasNext} onClick={() => setPage((current) => current + 1)}>
              Next
            </Button>
          </div>
        </>
      ) : (
        <EmptyState title="No executions yet" description="This skill has not been run yet." />
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ health

function HealthPanel({ installationId }: Readonly<{ installationId: string }>) {
  const api = useApi();
  const health = useQuery({
    queryKey: [...queryKey, installationId, "health"],
    queryFn: () => api.health(installationId)
  });

  if (health.isLoading) return <Skeleton />;
  if (health.isError)
    return (
      <Alert tone="danger" title="Unable to load health status">
        <Button onClick={() => health.refetch()}>Retry</Button>
      </Alert>
    );
  if (!health.data) return <EmptyState title="No health data" description="Health has not been checked yet." />;

  return (
    <Card>
      <div className="admin-section-header">
        <h2>Health</h2>
        <Badge tone={statusTone(health.data.status)}>{health.data.status}</Badge>
      </div>
      <p style={{ color: "var(--muted)" }}>
        Checked at {new Date(health.data.checkedAt).toLocaleString()}
      </p>
      {health.data.checks.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {health.data.checks.map((check, index) => (
                <tr key={index}>
                  <td>{check.name ?? `Check ${index + 1}`}</td>
                  <td>{check.status ? <Badge tone={statusTone(check.status)}>{check.status}</Badge> : "—"}</td>
                  <td>{check.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "var(--muted)" }}>No individual checks reported.</p>
      )}
    </Card>
  );
}
