import type { ApiClient } from "../../lib/api-client";

export type SkillVisibility = "PUBLIC" | "PRIVATE" | "ORG_ONLY";
export type SkillInstallationStatus = "INSTALLED" | "ENABLED" | "DISABLED" | "FAILED" | "UNINSTALLED";
export type SkillRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "CANCELLED";

export interface SkillMarketplaceItem {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  author: string;
  icon: string | null;
  visibility: SkillVisibility;
  latestVersion: string;
  versions: string[];
  installedVersions: string[];
  installed: boolean;
}

export interface SkillDefinitionSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  author: string;
  visibility: SkillVisibility;
  icon: string | null;
  latestVersion: string;
}

export interface SkillVersionDependency {
  id: string;
  dependencySkillKey: string;
  versionConstraint: string;
  required: boolean;
}

export interface SkillVersionInfo {
  id: string;
  version: string;
  manifestJson: Record<string, unknown>;
  skill: SkillDefinitionSummary;
  dependencies: SkillVersionDependency[];
}

/** A skill installation as returned by GET /skills/installations (list) — includes aggregate counts
 *  but not the per-employee grant rows. */
export interface SkillInstallation {
  id: string;
  status: SkillInstallationStatus;
  enabled: boolean;
  configurationJson: Record<string, unknown>;
  installedAt: string;
  skillVersion: SkillVersionInfo;
  _count: { grants: number; executions: number };
}

/** A skill installation as returned by GET /skills/installations/:id — includes the raw grant rows
 *  (one per granted employee) but not the aggregate `_count`. */
export interface SkillInstallationDetail {
  id: string;
  status: SkillInstallationStatus;
  enabled: boolean;
  configurationJson: Record<string, unknown>;
  installedAt: string;
  skillVersion: SkillVersionInfo;
  grants: Array<{ pluginInstallation: { id: string; displayName: string; slug: string } }>;
}

export interface EmployeeSkillGrant {
  id: string;
  pluginInstallationId: string;
  skillInstallationId: string;
  enabled: boolean;
  configurationOverrideJson: Record<string, unknown> | null;
  createdAt: string;
  pluginInstallation: { id: string; displayName: string; slug: string };
}

export interface SkillRun {
  id: string;
  skillKey: string;
  skillVersion: string;
  status: SkillRunStatus;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  creditsConsumed: number;
  retryCount: number;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

export interface SkillExecutionsPage {
  items: SkillRun[];
  total: number;
}

export interface SkillHealthCheck {
  name?: string;
  status?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface SkillHealthReport {
  status: string;
  checks: SkillHealthCheck[];
  checkedAt: string;
}

export interface SkillInstallInput {
  skillKey: string;
  versionConstraint?: string;
  configuration?: Record<string, unknown>;
  enabled?: boolean;
  approveSensitivePermissions?: boolean;
}

// ------------------------------------------------------------------ Sprint 6.1B — pipelines

export type SkillPipelineNodeFailureMode = "STOP" | "CONTINUE";
export type SkillPipelineExecutionStatus = "RUNNING" | "COMPLETED" | "FAILED" | "PARTIAL";
export type SkillPipelineNodeExecutionStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export interface SkillPipelineNode {
  id: string;
  skillPipelineId: string;
  order: number;
  skillKey: string;
  versionConstraint: string | null;
  conditionExpression: string | null;
  onFailure: SkillPipelineNodeFailureMode;
  timeoutMs: number | null;
  maxRetries: number;
  inputMappingJson: Record<string, unknown> | null;
  createdAt: string;
}

export interface SkillPipeline {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  isActive: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  nodes: SkillPipelineNode[];
}

export interface SkillPipelineWithNodes extends SkillPipeline {
  _count: { executions: number };
}

export interface SkillPipelineNodeExecution {
  id: string;
  skillPipelineExecutionId: string;
  skillPipelineNodeId: string;
  order: number;
  skillKey: string;
  status: SkillPipelineNodeExecutionStatus;
  skillRunId: string | null;
  retryCount: number;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  createdAt: string;
}

export interface SkillPipelineExecution {
  id: string;
  organizationId: string;
  skillPipelineId: string;
  pluginInstallationId: string | null;
  status: SkillPipelineExecutionStatus;
  traceId: string | null;
  triggerInputJson: unknown;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  createdAt: string;
}

export interface SkillPipelineExecutionWithNodes extends SkillPipelineExecution {
  nodeExecutions: SkillPipelineNodeExecution[];
  skillPipeline?: { id: string; name: string };
}

export interface SkillPipelineExecutionsPage {
  items: SkillPipelineExecution[];
  total: number;
}

export interface SkillPipelineNodeInput {
  order: number;
  skillKey: string;
  versionConstraint?: string;
  conditionExpression?: string;
  onFailure?: SkillPipelineNodeFailureMode;
  timeoutMs?: number;
  maxRetries?: number;
  useTriggerInput?: boolean;
  staticInput?: Record<string, unknown>;
}

export interface SkillPipelineCreateInput {
  name: string;
  description: string;
  nodes: SkillPipelineNodeInput[];
}

export interface SkillPipelineExecuteInput {
  input?: unknown;
  pluginInstallationId?: string;
  conversationId?: string;
  workflowExecutionId?: string;
}

// ------------------------------------------------------------------ Sprint 6.1B — packs

export type SkillPackInstallationStatus = "INSTALLED" | "PARTIAL" | "UNINSTALLED";

export interface SkillPackItem {
  id: string;
  skillPackId: string;
  skillKey: string;
  versionConstraint: string;
  required: boolean;
  order: number;
  createdAt: string;
}

export interface SkillPackInstallation {
  id: string;
  organizationId: string;
  skillPackId: string;
  packVersion: string;
  status: SkillPackInstallationStatus;
  installedByUserId: string;
  installedAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SkillPack {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  industry: string | null;
  author: string;
  icon: string | null;
  version: string;
  isActive: boolean;
  items: SkillPackItem[];
  installed: boolean;
  installation: SkillPackInstallation | null;
}

export interface SkillPackItemOutcome {
  skillKey: string;
  outcome: "INSTALLED" | "ALREADY_INSTALLED" | "FAILED";
  error?: string;
}

export interface SkillPackInstallResult {
  installation: SkillPackInstallation;
  results: SkillPackItemOutcome[];
}

// ------------------------------------------------------------------ Sprint 6.1B — templates

export interface SkillTemplateItem {
  id: string;
  skillTemplateId: string;
  skillKey: string;
  versionConstraint: string;
  order: number;
  defaultConfigurationJson: Record<string, unknown>;
  createdAt: string;
}

export interface SkillTemplate {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  industry: string | null;
  author: string;
  icon: string | null;
  targetPluginId: string;
  workflowRef: string | null;
  version: string;
  isActive: boolean;
  items: SkillTemplateItem[];
  installationCount: number;
}

export interface SkillTemplateInstallResult {
  installation: {
    id: string;
    organizationId: string;
    skillTemplateId: string;
    pluginInstallationId: string;
    installedByUserId: string;
    installedAt: string;
  };
  pluginInstallationId: string;
  installedSkills: string[];
}

// ------------------------------------------------------------------ Sprint 6.1B — analytics

export interface SkillAnalyticsRow {
  skillKey: string;
  name: string;
  category: string;
  executions: number;
  completedExecutions: number;
  failedExecutions: number;
  successRate: number;
  failureRate: number;
  avgLatencyMs: number;
  creditsConsumed: number;
  totalTokens: number;
  employeesUsing: number;
  installed: boolean;
}

export interface SkillAnalyticsReport {
  scope: { organizationId: string; from: string | null; to: string | null };
  totals: {
    executions: number;
    creditsConsumed: number;
    totalTokens: number;
    successRate: number;
    failureRate: number;
    avgLatencyMs: number;
    employeesUsing: number;
    organizationsUsing: number;
  };
  perSkill: SkillAnalyticsRow[];
  topSkills: SkillAnalyticsRow[];
  leastUsed: SkillAnalyticsRow[];
  mostGranted: SkillAnalyticsRow[];
  mostFailed: SkillAnalyticsRow[];
  slowestSkills: SkillAnalyticsRow[];
}

export interface SkillAnalyticsFilters {
  from?: string;
  to?: string;
  skillKey?: string;
  pluginInstallationId?: string;
  [key: string]: string | undefined;
}

// ------------------------------------------------------------------ Sprint 6.1B — search & recommend

export interface SkillSearchFilters {
  query?: string;
  category?: string;
  capability?: string;
  mimeType?: string;
  industry?: string;
  tag?: string;
  author?: string;
  installed?: boolean;
  [key: string]: string | boolean | undefined;
}

export interface SkillSearchResult {
  key: string;
  name: string;
  description: string;
  category: string;
  author: string;
  industry: string[];
  tags: string[];
  supportedMimeTypes: string[];
  capabilitySummary: string[];
  installed: boolean;
  score: number;
}

export interface SkillRecommendFilters {
  message?: string;
  intent?: string;
  contentType?: string;
  mimeTypes?: string;
  pluginInstallationId?: string;
  [key: string]: string | undefined;
}

export interface SkillRecommendation {
  skillKey: string;
  name: string;
  description: string;
  category: string;
  score: number;
  reasons: string[];
  supportedMimeTypes: string[];
  capabilitySummary: string[];
  installed: boolean;
  granted: boolean;
}

function toQueryString<T extends Record<string, string | number | boolean | undefined>>(params: T): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const search = query.toString();
  return search ? `?${search}` : "";
}

export function createSkillApi(client: ApiClient) {
  return {
    marketplace: () =>
      client.request<{ items: SkillMarketplaceItem[] }>("/skills/marketplace"),
    installations: () => client.request<SkillInstallation[]>("/skills/installations"),
    getInstallation: (id: string) =>
      client.request<SkillInstallationDetail>(`/skills/installations/${id}`),
    install: (body: SkillInstallInput) =>
      client.request<SkillInstallation>("/skills/install", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    uninstall: (id: string) =>
      client.request<unknown>(`/skills/installations/${id}`, { method: "DELETE" }),
    enable: (id: string) =>
      client.request<SkillInstallation>(`/skills/installations/${id}/enable`, { method: "PATCH" }),
    disable: (id: string) =>
      client.request<SkillInstallation>(`/skills/installations/${id}/disable`, { method: "PATCH" }),
    configure: (id: string, configuration: Record<string, unknown>) =>
      client.request<SkillInstallation>(`/skills/installations/${id}/configure`, {
        method: "PATCH",
        body: JSON.stringify({ configuration })
      }),
    updateVersion: (id: string, versionConstraint: string) =>
      client.request<SkillInstallation>(`/skills/installations/${id}/update-version`, {
        method: "POST",
        body: JSON.stringify({ versionConstraint })
      }),
    rollback: (id: string) =>
      client.request<SkillInstallation>(`/skills/installations/${id}/rollback`, { method: "POST" }),
    listGrants: (id: string) =>
      client.request<EmployeeSkillGrant[]>(`/skills/installations/${id}/grants`),
    grant: (id: string, pluginInstallationId: string, configurationOverride?: Record<string, unknown>) =>
      client.request<unknown>(`/skills/installations/${id}/grants`, {
        method: "POST",
        body: JSON.stringify({
          pluginInstallationId,
          ...(configurationOverride ? { configurationOverride } : {})
        })
      }),
    revokeGrant: (id: string, employeeId: string) =>
      client.request<unknown>(`/skills/installations/${id}/grants/${employeeId}`, {
        method: "DELETE"
      }),
    setGrantEnabled: (id: string, employeeId: string, enabled: boolean) =>
      client.request<unknown>(`/skills/installations/${id}/grants/${employeeId}/state`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      }),
    executions: (id: string, page: number, pageSize: number) =>
      client.request<SkillExecutionsPage>(
        `/skills/installations/${id}/executions?page=${page}&pageSize=${pageSize}`
      ),
    health: (id: string) => client.request<SkillHealthReport>(`/skills/installations/${id}/health`),

    // ------------------------------------------------------------------ Sprint 6.1B — pipelines
    listPipelines: () => client.request<SkillPipelineWithNodes[]>("/skills/pipelines"),
    createPipeline: (input: SkillPipelineCreateInput) =>
      client.request<SkillPipeline>("/skills/pipeline", { method: "POST", body: JSON.stringify(input) }),
    getPipeline: (pipelineId: string) => client.request<SkillPipeline>(`/skills/pipeline/${pipelineId}`),
    deletePipeline: (pipelineId: string) =>
      client.request<unknown>(`/skills/pipeline/${pipelineId}`, { method: "DELETE" }),
    executePipeline: (pipelineId: string, input: SkillPipelineExecuteInput) =>
      client.request<SkillPipelineExecutionWithNodes>(`/skills/pipeline/${pipelineId}/execute`, {
        method: "POST",
        body: JSON.stringify(input)
      }),
    listPipelineExecutions: (pipelineId: string, page: number, pageSize: number) =>
      client.request<SkillPipelineExecutionsPage>(
        `/skills/pipeline/${pipelineId}/executions?page=${page}&pageSize=${pageSize}`
      ),
    getPipelineExecution: (executionId: string) =>
      client.request<SkillPipelineExecutionWithNodes>(`/skills/pipeline-executions/${executionId}`),

    // ------------------------------------------------------------------ Sprint 6.1B — packs
    listPacks: () => client.request<SkillPack[]>("/skills/packs"),
    installPack: (packKey: string, approveSensitivePermissions?: boolean) =>
      client.request<SkillPackInstallResult>("/skills/packs/install", {
        method: "POST",
        body: JSON.stringify({ packKey, ...(approveSensitivePermissions !== undefined ? { approveSensitivePermissions } : {}) })
      }),
    updatePack: (packKey: string) =>
      client.request<SkillPackInstallResult>(`/skills/packs/${packKey}/update`, { method: "POST" }),
    removePack: (packKey: string) =>
      client.request<unknown>(`/skills/packs/${packKey}`, { method: "DELETE" }),

    // ------------------------------------------------------------------ Sprint 6.1B — templates
    listTemplates: () => client.request<SkillTemplate[]>("/skills/templates"),
    installTemplate: (input: { templateKey: string; pluginInstallationId?: string; approveSensitivePermissions?: boolean }) =>
      client.request<SkillTemplateInstallResult>("/skills/templates/install", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    // ------------------------------------------------------------------ Sprint 6.1B — analytics
    analytics: (filters: SkillAnalyticsFilters = {}) =>
      client.request<SkillAnalyticsReport>(`/skills/analytics${toQueryString(filters)}`),
    analyticsExportCsv: (filters: SkillAnalyticsFilters = {}) =>
      client.requestBlob(`/skills/analytics/export${toQueryString(filters)}`),

    // ------------------------------------------------------------------ Sprint 6.1B — search & recommend
    search: (filters: SkillSearchFilters = {}) =>
      client.request<SkillSearchResult[]>(`/skills/search${toQueryString(filters)}`),
    recommend: (filters: SkillRecommendFilters = {}) =>
      client.request<SkillRecommendation[]>(`/skills/recommend${toQueryString(filters)}`)
  };
}
