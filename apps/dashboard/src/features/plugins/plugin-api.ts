import type { ApiClient } from "../../lib/api-client";
export type PluginStatus = "ACTIVE" | "DISABLED" | "DEPRECATED";
export interface PluginRecord {
  id: string;
  name: string;
  slug: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  status: PluginStatus;
  manifest: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface PluginConfiguration {
  pluginId: string;
  config: Record<string, unknown>;
  secretKeys: string[];
  updatedAt: string;
}
export function createPluginApi(client: ApiClient) {
  return {
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
      manifest: Record<string, unknown>;
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
      client.request<{ status: "READY" | "FAILED" | "DISABLED"; checkedAt: string }>(
        `/plugins/${id}/health`
      )
  };
}
