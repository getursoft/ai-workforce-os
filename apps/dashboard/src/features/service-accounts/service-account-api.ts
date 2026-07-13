import type { ApiClient } from "../../lib/api-client";
export type AccountStatus = "ACTIVE" | "DISABLED" | "ARCHIVED";
export interface ApiKeyMeta {
  id: string;
  name: string;
  maskedValue: string;
  environment: "LIVE" | "TEST" | "DEVELOPMENT";
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface ServiceAccount {
  id: string;
  name: string;
  description: string | null;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  roles: Array<{ roleId: string; role: { id: string; name: string } }>;
  apiKeys?: ApiKeyMeta[];
  _count?: { apiKeys: number };
}
export interface Page {
  items: ServiceAccount[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}
const qs = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== "") p.set(k, String(v));
  });
  return p.toString() ? `?${p}` : "";
};
export function createServiceAccountApi(client: ApiClient) {
  return {
    list: (q: Record<string, string | number | undefined> = {}) =>
      client.request<Page>(`/service-accounts${qs(q)}`),
    get: (id: string) => client.request<ServiceAccount>(`/service-accounts/${id}`),
    create: (v: { name: string; description?: string; roleIds: string[] }) =>
      client.request<ServiceAccount>("/service-accounts", {
        method: "POST",
        body: JSON.stringify(v)
      }),
    update: (
      id: string,
      v: Partial<{ name: string; description: string; status: AccountStatus; roleIds: string[] }>
    ) =>
      client.request<ServiceAccount>(`/service-accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(v)
      }),
    remove: (id: string) =>
      client.request<undefined>(`/service-accounts/${id}`, { method: "DELETE" }),
    createKey: (id: string, v: { name: string; environment: string; expiresAt?: string }) =>
      client.request<{ apiKey: ApiKeyMeta; secret: string; message: string }>(
        `/service-accounts/${id}/api-keys`,
        { method: "POST", body: JSON.stringify(v) }
      ),
    rotate: (id: string, keyId: string) =>
      client.request<{ apiKey: ApiKeyMeta; secret: string; message: string }>(
        `/service-accounts/${id}/api-keys/${keyId}/rotate`,
        { method: "POST" }
      ),
    revoke: (id: string, keyId: string) =>
      client.request<ApiKeyMeta>(`/service-accounts/${id}/api-keys/${keyId}/revoke`, {
        method: "POST"
      })
  };
}
