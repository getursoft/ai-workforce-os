import type { ApiClient } from "../../lib/api-client";

export interface ApprovalRequest {
  id: string;
  organizationId: string;
  workflowExecutionId: string;
  agentId: string;
  requestedBy: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  title: string;
  description: string;
  payload: Record<string, unknown>;
  comments: Array<{ author: string; text: string; createdAt: string }>;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createApprovalApi(client: ApiClient) {
  return {
    list: (organizationId: string, status?: string) =>
      client.request<ApprovalRequest[]>(`/approvals?organizationId=${organizationId}${status ? `&status=${status}` : ""}`),
    get: (id: string, organizationId: string) =>
      client.request<ApprovalRequest>(`/approvals/${id}?organizationId=${organizationId}`),
    approve: (id: string, body: { organizationId: string; approvedBy: string; comment?: string }) =>
      client.request<ApprovalRequest>(`/approvals/${id}/approve`, { method: "POST", body: JSON.stringify(body) }),
    reject: (id: string, body: { organizationId: string; rejectedBy: string; comment?: string }) =>
      client.request<ApprovalRequest>(`/approvals/${id}/reject`, { method: "POST", body: JSON.stringify(body) })
  };
}
