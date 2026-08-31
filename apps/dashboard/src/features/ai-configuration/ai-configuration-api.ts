import type { ApiClient } from "../../lib/api-client";

export type AiProviderType = "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
export type AiProviderConnectionStatus = "ACTIVE" | "DISABLED";
export type AiProviderHealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
export type AiProfilePurpose =
  | "DEFAULT"
  | "ROUTING"
  | "CONVERSATION"
  | "REASONING"
  | "EXTRACTION"
  | "SUMMARIZATION"
  | "EMBEDDING";

export interface AiProviderConnection {
  id: string;
  organizationId: string;
  name: string;
  providerType: AiProviderType;
  baseUrl: string | null;
  status: AiProviderConnectionStatus;
  isDefault: boolean;
  metadataJson: Record<string, unknown>;
  credentialConfigured: boolean;
  lastHealthCheckAt: string | null;
  lastHealthStatus: AiProviderHealthStatus;
  modelProfileCount: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelProfile {
  id: string;
  organizationId: string;
  providerConnectionId: string;
  name: string;
  purpose: AiProfilePurpose;
  model: string | null;
  embeddingModel: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
  additionalSettingsJson: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { employeeAssignments: number };
}

export interface EmployeeAiProfileAssignment {
  id: string;
  organizationId: string;
  pluginInstallationId: string;
  modelProfileId: string;
  purpose: AiProfilePurpose;
  modelProfile: { id: string; name: string; purpose: AiProfilePurpose; model: string | null };
}

export interface OrganizationAiDefaults {
  organizationId: string;
  defaultProfileId: string | null;
  routingProfileId: string | null;
  reasoningProfileId: string | null;
  embeddingProfileId: string | null;
}

export interface ConnectionTestResult {
  status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  providerReachable: boolean | null;
  authenticationValid: boolean | null;
  modelAvailable: boolean | null;
  latencyMs: number;
  errorCode: string | null;
}

export interface BackfillResult {
  legacyConfigsScanned: number;
  connectionsCreated: number;
  connectionsReused: number;
  profilesCreated: number;
  profilesReused: number;
  assignmentsCreated: number;
  skipped: number;
  errors: number;
}

export function createAiConfigurationApi(client: ApiClient) {
  return {
    listConnections: () => client.request<AiProviderConnection[]>("/ai-configuration/connections"),
    getConnection: (id: string) => client.request<AiProviderConnection>(`/ai-configuration/connections/${id}`),
    createConnection: (body: {
      name: string;
      providerType: AiProviderType;
      baseUrl?: string;
      apiKey?: string;
      metadataJson?: Record<string, unknown>;
      isDefault?: boolean;
    }) =>
      client.request<AiProviderConnection>("/ai-configuration/connections", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    updateConnection: (
      id: string,
      body: {
        name?: string;
        baseUrl?: string;
        apiKey?: string;
        removeCredential?: boolean;
        metadataJson?: Record<string, unknown>;
        status?: AiProviderConnectionStatus;
        isDefault?: boolean;
      }
    ) =>
      client.request<AiProviderConnection>(`/ai-configuration/connections/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    deleteConnection: (id: string) =>
      client.request<undefined>(`/ai-configuration/connections/${id}`, { method: "DELETE" }),
    testConnection: (id: string) =>
      client.request<ConnectionTestResult>(`/ai-configuration/connections/${id}/test`, { method: "POST" }),
    discoverModels: (id: string) => client.request<string[]>(`/ai-configuration/connections/${id}/models`),

    listProfiles: (purpose?: AiProfilePurpose) =>
      client.request<AiModelProfile[]>(
        `/ai-configuration/profiles${purpose ? `?purpose=${purpose}` : ""}`
      ),
    createProfile: (body: {
      name: string;
      providerConnectionId: string;
      purpose: AiProfilePurpose;
      model?: string;
      embeddingModel?: string;
      temperature?: number;
      maxOutputTokens?: number;
      timeoutMs?: number;
      isDefault?: boolean;
      isActive?: boolean;
    }) =>
      client.request<AiModelProfile>("/ai-configuration/profiles", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    updateProfile: (
      id: string,
      body: Partial<{
        name: string;
        providerConnectionId: string;
        purpose: AiProfilePurpose;
        model: string;
        embeddingModel: string;
        temperature: number;
        maxOutputTokens: number;
        timeoutMs: number;
        isDefault: boolean;
        isActive: boolean;
      }>
    ) =>
      client.request<AiModelProfile>(`/ai-configuration/profiles/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    deleteProfile: (id: string) =>
      client.request<undefined>(`/ai-configuration/profiles/${id}`, { method: "DELETE" }),

    listAssignments: (pluginId: string) =>
      client.request<EmployeeAiProfileAssignment[]>(`/ai-configuration/employees/${pluginId}/assignments`),
    upsertAssignment: (pluginId: string, body: { modelProfileId: string; purpose: AiProfilePurpose }) =>
      client.request<EmployeeAiProfileAssignment>(`/ai-configuration/employees/${pluginId}/assignments`, {
        method: "PUT",
        body: JSON.stringify(body)
      }),
    removeAssignment: (pluginId: string, purpose: AiProfilePurpose) =>
      client.request<undefined>(`/ai-configuration/employees/${pluginId}/assignments/${purpose}`, {
        method: "DELETE"
      }),

    getOrganizationDefaults: () =>
      client.request<OrganizationAiDefaults>("/ai-configuration/organization-defaults"),
    updateOrganizationDefaults: (
      body: Partial<{
        defaultProfileId: string | null;
        routingProfileId: string | null;
        reasoningProfileId: string | null;
        embeddingProfileId: string | null;
      }>
    ) =>
      client.request<OrganizationAiDefaults>("/ai-configuration/organization-defaults", {
        method: "PATCH",
        body: JSON.stringify(body)
      }),

    runBackfill: () =>
      client.request<BackfillResult>("/ai-configuration/backfill", { method: "POST" })
  };
}
