import type { ApiClient } from "../../../lib/api-client";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "EXPIRED" | "CANCELLED" | "SUPERSEDED";

export interface ApprovalRequestData {
  id: string;
  organizationId: string;
  workflowExecutionId: string;
  policyId: string | null;
  agentId: string;
  actionType: string;
  subjectType: string | null;
  subjectId: string | null;
  requesterType: string;
  requesterUserId: string | null;
  requesterExternalId: string | null;
  requestedBy: string;
  status: ApprovalStatus;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  comments: ApprovalComment[];
  approverType: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  supersededById: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalComment {
  author: string;
  text: string;
  createdAt: string;
}

export function createApprovalApi(client: ApiClient, orgId: string, userId: string) {
  const base = (path: string) => client.request<unknown>(`/approvals${path}`);

  return {
    list: (params?: { status?: ApprovalStatus; actionType?: string; limit?: number; offset?: number }) => {
      const query = new URLSearchParams({ organizationId: orgId });
      if (params?.status) query.set("status", params.status);
      if (params?.actionType) query.set("actionType", params.actionType);
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.offset) query.set("offset", String(params.offset));
      return client.request<{ items: ApprovalRequestData[]; total: number }>(
        `/approvals?${query.toString()}`
      );
    },

    myPending: () => {
      const query = new URLSearchParams({ organizationId: orgId, userId });
      return client.request<ApprovalRequestData[]>(`/approvals/my-pending?${query.toString()}`);
    },

    get: (id: string) => {
      const query = new URLSearchParams({ organizationId: orgId });
      return client.request<ApprovalRequestData>(`/approvals/${id}?${query.toString()}`);
    },

    approve: (id: string, comment?: string) =>
      base(`/${id}/approve`).then(() =>
        client.request<ApprovalRequestData>(`/approvals/${id}/approve`, {
          method: "POST",
          body: JSON.stringify({ organizationId: orgId, userId, comment }),
        })
      ),

    reject: (id: string, comment?: string) =>
      client.request<ApprovalRequestData>(`/approvals/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, userId, comment }),
      }),

    requestChanges: (id: string, comment?: string) =>
      client.request<ApprovalRequestData>(`/approvals/${id}/request-changes`, {
        method: "POST",
        body: JSON.stringify({ organizationId: orgId, userId, comment }),
      }),

    decisions: (id: string) =>
      client.request<unknown[]>(`/approvals/${id}/decisions`),

    audit: (id: string) =>
      client.request<unknown[]>(`/approvals/${id}/audit`),
  };
}
