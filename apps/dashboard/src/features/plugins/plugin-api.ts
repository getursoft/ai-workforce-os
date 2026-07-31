import type { ApiClient } from "../../lib/api-client";
export type PluginStatus = "ACTIVE" | "DISABLED" | "DEPRECATED" | "FAILED";
export interface PluginSchemaProperty {
  type: "string" | "boolean" | "number" | "integer";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: Array<string | number>;
  format?: string;
  writeOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
export interface PluginConfigurationSchema {
  type: "object";
  properties?: Record<string, PluginSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}
export interface PublicPluginManifest {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  permissions: string[];
  capabilities: string[];
  tools: Array<{ name: string; description: string }>;
  configSchema?: PluginConfigurationSchema;
}
export interface AvailablePlugin extends PublicPluginManifest {
  installed: boolean;
}
export type PluginHealthStatus = "READY" | "DEGRADED" | "FAILED" | "UNKNOWN";
export interface PluginRecord {
  id: string;
  name: string;
  slug: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  status: PluginStatus;
  manifest: PublicPluginManifest;
  createdAt: string;
  updatedAt: string;
  lastHealthStatus: PluginHealthStatus | null;
  lastHealthCheckedAt: string | null;
  grantedPermissions: string[];
}
export interface PluginConfiguration {
  pluginId: string;
  config: Record<string, unknown>;
  secretKeys: string[];
  updatedAt: string;
}
export type AiProviderType = "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
export interface PluginAiConfiguration {
  pluginInstallationId: string;
  configured: boolean;
  providerType: AiProviderType | null;
  configuration: {
    model?: string;
    embeddingModel?: string;
    baseUrl?: string;
    endpoint?: string;
    deploymentName?: string;
    embeddingDeployment?: string;
    apiVersion?: string;
    timeoutMs?: number;
  };
  secrets: { apiKey: { configured: boolean; updatedAt: string | null } };
  updatedAt: string | null;
}
export interface EmailConfiguration {
  pluginInstallationId: string;
  configured: boolean;
  configuration: {
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUser?: string;
    fromEmail?: string;
    fromName?: string;
  };
  secrets: { password: { configured: boolean; updatedAt: string | null } };
  updatedAt: string | null;
}
export interface UpdateEmailConfigurationInput {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  fromEmail?: string;
  fromName?: string;
  secrets?: { password?: string };
  removeSecrets?: string[];
}
export interface PluginChatResult {
  message: string;
  provider: string;
  model: string;
  toolExecutions: Array<{ tool: string; status: string; durationMs: number }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}
export function createPluginApi(client: ApiClient) {
  return {
    available: () =>
      client.request<{
        items: AvailablePlugin[];
        errors: Array<{ plugin: string; code: string }>;
      }>("/plugins/available"),
    list: (q: { page: number; pageSize: number; search?: string; status?: string }) =>
      client.request<{
        items: PluginRecord[];
        pagination: { page: number; pages: number; total: number };
      }>(
        `/plugins?${new URLSearchParams(
          Object.entries(q)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)])
        ).toString()}`
      ),
    get: (id: string) => client.request<PluginRecord>(`/plugins/${id}`),
    install: (body: {
      pluginId: string;
      grantedPermissions: string[];
      enable: boolean;
      configuration: { config: Record<string, unknown>; secrets: Record<string, string> };
    }) =>
      client.request<PluginRecord>("/plugins/install", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    enable: (id: string) =>
      client.request<PluginRecord>(`/plugins/${id}/enable`, { method: "POST" }),
    disable: (id: string) =>
      client.request<PluginRecord>(`/plugins/${id}/disable`, { method: "POST" }),
    remove: (id: string) => client.request<undefined>(`/plugins/${id}`, { method: "DELETE" }),
    configuration: (id: string) =>
      client.request<PluginConfiguration>(`/plugins/${id}/configuration`),
    updateConfiguration: (
      id: string,
      body: { config: Record<string, unknown>; secrets: Record<string, string | null> }
    ) =>
      client.request<PluginConfiguration>(`/plugins/${id}/configuration`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    updateGrants: (id: string, grantedPermissions: string[]) =>
      client.request<PluginRecord>(`/plugins/${id}/grants`, {
        method: "PATCH",
        body: JSON.stringify({ grantedPermissions })
      }),
    health: (id: string) =>
      client.request<{ status: PluginHealthStatus | "DISABLED"; checkedAt: string }>(
        `/plugins/${id}/health`,
        { method: "POST" }
      ),
    aiConfiguration: (id: string) =>
      client.request<PluginAiConfiguration>(`/plugins/${id}/ai-configuration`),
    updateAiConfiguration: (id: string, body: Record<string, unknown>) =>
      client.request<PluginAiConfiguration>(`/plugins/${id}/ai-configuration`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    testAiConfiguration: (id: string) =>
      client.request<{ success: boolean; provider: string; model: string }>(
        `/plugins/${id}/ai-configuration/test`,
        { method: "POST" }
      ),
    emailConfiguration: (id: string) =>
      client.request<EmailConfiguration>(`/plugins/${id}/email-configuration`),
    updateEmailConfiguration: (id: string, body: UpdateEmailConfigurationInput) =>
      client.request<EmailConfiguration>(`/plugins/${id}/email-configuration`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    chat: (
      id: string,
      body: {
        message: string;
        conversation: Array<{ role: "user" | "assistant"; content: string }>;
      }
    ) =>
      client.request<PluginChatResult>(`/plugins/${id}/chat`, {
        method: "POST",
        body: JSON.stringify(body)
      })
  };
}

export async function saveAndTestAiConfiguration(
  api: Pick<ReturnType<typeof createPluginApi>, "updateAiConfiguration" | "testAiConfiguration">,
  pluginId: string,
  body: Record<string, unknown>,
  refresh: () => Promise<unknown>
) {
  await api.updateAiConfiguration(pluginId, body);
  await refresh();
  return api.testAiConfiguration(pluginId);
}
