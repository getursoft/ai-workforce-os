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
}
export interface PluginConfiguration {
  pluginId: string;
  config: Record<string, unknown>;
  secretKeys: string[];
  updatedAt: string;
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
    health: (id: string) =>
      client.request<{ status: PluginHealthStatus | "DISABLED"; checkedAt: string }>(
        `/plugins/${id}/health`,
        { method: "POST" }
      )
  };
}
