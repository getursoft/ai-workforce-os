import type { ApiClient } from "../../../lib/api-client";

export type PlatformLeadSource = "WEBSITE_DEMO" | "CONTACT_SALES" | "CONTACT_US" | "WEBSITE_ENQUIRY" | "OTHER";
export type PlatformLeadType = "DEMO_REQUEST" | "SALES_ENQUIRY" | "GENERAL_ENQUIRY" | "OTHER";
export type PlatformLeadStatus = "NEW" | "CONTACTED" | "QUALIFIED" | "DEMO_SCHEDULED" | "WON" | "LOST";

export interface PlatformLead {
  id: string;
  scope: "PLATFORM";
  source: PlatformLeadSource;
  type: PlatformLeadType;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  requirement: string | null;
  metadata: Record<string, unknown>;
  preferredDemoDate: string | null;
  preferredDemoTime: string | null;
  timezone: string | null;
  status: PlatformLeadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformLeadSummary {
  total: number;
  new: number;
  demoRequests: number;
  contacted: number;
  qualified: number;
  won: number;
}

export interface ListPlatformLeadsParams {
  search?: string;
  source?: PlatformLeadSource | "ALL";
  status?: PlatformLeadStatus | "ALL";
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Platform-owner-only — every call here hits `/platform/sales-leads`, guarded server-side by
 *  PlatformOwnerGuard (see PlatformLeadsController). A non-platform-owner calling any of these methods
 *  gets a 403 from the API regardless of what the UI shows. */
export function createPlatformLeadsApi(client: ApiClient) {
  return {
    list: (params?: ListPlatformLeadsParams) => {
      const q = new URLSearchParams();
      if (params?.search) q.set("search", params.search);
      if (params?.source && params.source !== "ALL") q.set("source", params.source);
      if (params?.status && params.status !== "ALL") q.set("status", params.status);
      if (params?.from) q.set("from", params.from);
      if (params?.to) q.set("to", params.to);
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.offset) q.set("offset", String(params.offset));
      const qs = q.toString();
      return client.request<{ items: PlatformLead[]; total: number }>(
        `/platform/sales-leads${qs ? `?${qs}` : ""}`
      );
    },

    summary: () => client.request<PlatformLeadSummary>("/platform/sales-leads/summary"),

    get: (id: string) => client.request<PlatformLead>(`/platform/sales-leads/${id}`),

    updateStatus: (id: string, status: PlatformLeadStatus) =>
      client.request<PlatformLead>(`/platform/sales-leads/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      })
  };
}
