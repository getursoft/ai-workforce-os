import type { ApiClient } from "../../lib/api-client";

export type ConnectorStatus =
  | "DRAFT"
  | "CONNECTED"
  | "READY"
  | "DISABLED"
  | "AUTH_FAILED"
  | "EXPIRED"
  | "DEGRADED"
  | "FAILED"
  | "DISCONNECTED"
  | "ARCHIVED";
export interface ConnectorTool {
  id: string;
  name: string;
  displayName: string;
  description: string;
  requiredCapability: string;
  operationType: "READ" | "WRITE";
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  enabled: boolean;
}
export interface ConnectorDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string;
  version: string;
  authType: string;
  capabilities: string[];
  tools: ConnectorTool[];
  installed: boolean;
  configurationSchema: Record<string, unknown>;
  credentialSchema: Record<string, unknown>;
}
export interface ConnectorInstallation {
  id: string;
  displayName: string;
  status: ConnectorStatus;
  configuration: Record<string, unknown>;
  credentialMetadata: Record<string, { configured: boolean; updatedAt: string }>;
  credentialExpiresAt: string | null;
  grantedCapabilities: string[];
  lastHealthStatus: string;
  lastHealthCheckedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  connector: ConnectorDefinition;
}
export interface ConnectorPage<T> {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export function createConnectorApi(client: ApiClient) {
  const action = (id: string, name: string) =>
    client.request<ConnectorInstallation>(`/connector-installations/${id}/${name}`, {
      method: "POST"
    });
  return {
    catalogue: () => client.request<ConnectorDefinition[]>("/connectors"),
    definition: (id: string) => client.request<ConnectorDefinition>(`/connectors/${id}`),
    list: (query: { page?: number; pageSize?: number; search?: string; status?: string } = {}) =>
      client.request<ConnectorPage<ConnectorInstallation>>(
        `/connector-installations?${new URLSearchParams(
          Object.entries(query)
            .filter(([, value]) => value !== undefined && value !== "")
            .map(([key, value]) => [key, String(value)])
        )}`
      ),
    get: (id: string) => client.request<ConnectorInstallation>(`/connector-installations/${id}`),
    install: (body: {
      connectorKey: string;
      displayName: string;
      configuration?: Record<string, unknown>;
      credentials?: Record<string, string>;
      grantedCapabilities: string[];
    }) =>
      client.request<ConnectorInstallation>("/connector-installations", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    update: (id: string, displayName: string) =>
      client.request<ConnectorInstallation>(`/connector-installations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName })
      }),
    updateConfiguration: (id: string, configuration: Record<string, unknown>) =>
      client.request<ConnectorInstallation>(`/connector-installations/${id}/configuration`, {
        method: "PATCH",
        body: JSON.stringify({ configuration })
      }),
    updateCredentials: (id: string, credentials: Record<string, string>) =>
      client.request<ConnectorInstallation>(`/connector-installations/${id}/credentials`, {
        method: "PATCH",
        body: JSON.stringify({ credentials })
      }),
    removeCredentials: (id: string) =>
      client.request<ConnectorInstallation>(`/connector-installations/${id}/credentials`, {
        method: "DELETE"
      }),
    updateCapabilities: (id: string, grantedCapabilities: string[]) =>
      client.request<ConnectorInstallation>(`/connector-installations/${id}/capabilities`, {
        method: "PATCH",
        body: JSON.stringify({ grantedCapabilities })
      }),
    enable: (id: string) => action(id, "enable"),
    disable: (id: string) => action(id, "disable"),
    test: (id: string) => action(id, "test"),
    health: (id: string) => action(id, "health"),
    disconnect: (id: string) => action(id, "disconnect"),
    reconnect: (id: string) => action(id, "reconnect"),
    remove: (id: string) =>
      client.request<unknown>(`/connector-installations/${id}`, { method: "DELETE" }),
    tools: (id: string) => client.request<ConnectorTool[]>(`/connector-installations/${id}/tools`),
    executions: (id: string) =>
      client.request<ConnectorPage<Record<string, unknown>>>(
        `/connector-installations/${id}/executions?page=1&pageSize=20`
      ),
    events: (id: string) =>
      client.request<ConnectorPage<Record<string, unknown>>>(
        `/connector-installations/${id}/events?page=1&pageSize=20`
      ),
    audit: (id: string) =>
      client.request<ConnectorPage<Record<string, unknown>>>(
        `/connector-installations/${id}/audit?page=1&pageSize=20`
      )
  };
}
