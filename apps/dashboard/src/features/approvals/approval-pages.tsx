"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth, useCurrentUser } from "../auth/auth-provider";
import { createApprovalApi } from "./approval-api";
import { Button, Card, Badge, EmptyState, Dialog, PageHeader } from "../../components/ui";
import { AccessGate } from "../admin/authorization";
import type { ApprovalRequest } from "./approval-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createApprovalApi(client), [client]);
}

function StatusBadge({ status }: { status: ApprovalRequest["status"] }) {
  const map: Record<string, { tone: "warning" | "success" | "danger" | "neutral"; label: string }> = {
    PENDING: { tone: "warning", label: "Pending" },
    APPROVED: { tone: "success", label: "Approved" },
    REJECTED: { tone: "danger", label: "Rejected" },
    EXPIRED: { tone: "neutral", label: "Expired" }
  };
  const m = map[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ApprovalsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const [activeTab, setActiveTab] = useState<string>("PENDING");
  const [actionTarget, setActionTarget] = useState<ApprovalRequest | null>(null);
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["approvals", activeTab],
    queryFn: () => api.list(user?.organizationId ?? "", activeTab === "ALL" ? undefined : activeTab)
  });

  const approveMutation = useMutation({
    mutationFn: (vars: { id: string; comment?: string }) =>
      api.approve(vars.id, { organizationId: user?.organizationId ?? "", approvedBy: user?.email ?? "admin", ...(vars.comment ? { comment: vars.comment } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      setActionTarget(null);
      setActionType(null);
    }
  });

  const rejectMutation = useMutation({
    mutationFn: (vars: { id: string; comment?: string }) =>
      api.reject(vars.id, { organizationId: user?.organizationId ?? "", rejectedBy: user?.email ?? "admin", ...(vars.comment ? { comment: vars.comment } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      setActionTarget(null);
      setActionType(null);
    }
  });

  const handleAction = () => {
    if (!actionTarget || !actionType) return;
    if (actionType === "approve") approveMutation.mutate({ id: actionTarget.id });
    else rejectMutation.mutate({ id: actionTarget.id });
  };

  return (
    <AccessGate permission="approvals.read">
      <section className="admin-page">
        <PageHeader title="Approvals" description="Review and manage workflow approval requests." />
        <Card className="admin-toolbar">
          <div className="admin-tabs">
            {["PENDING", "APPROVED", "REJECTED"].map((tab) => (
              <button
                key={tab}
                className={`admin-tab ${activeTab === tab ? "admin-tab--active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab.charAt(0) + tab.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </Card>
        {isLoading ? (
          <Card><div className="admin-loading">Loading approvals...</div></Card>
        ) : !data?.length ? (
          <EmptyState title="No approvals" description={`No ${activeTab.toLowerCase()} approval requests.`} />
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Workflow</th>
                  <th>Requested By</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((req) => (
                  <tr key={req.id}>
                    <td className="admin-table__title">{req.title}</td>
                    <td><code className="admin-code">{req.workflowExecutionId.slice(0, 8)}</code></td>
                    <td>{req.requestedBy}</td>
                    <td className="admin-table__muted">{new Date(req.createdAt).toLocaleDateString()}</td>
                    <td><StatusBadge status={req.status} /></td>
                    <td>
                      {req.status === "PENDING" && (
                        <div className="admin-action-group">
                          <Button variant="primary" onClick={() => { setActionTarget(req); setActionType("approve"); }}>
                            Approve
                          </Button>
                          <Button variant="danger" onClick={() => { setActionTarget(req); setActionType("reject"); }}>
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {actionTarget && actionType && (
          <Dialog
            open
            title={actionType === "approve" ? "Approve Request" : "Reject Request"}
            onConfirm={handleAction}
            onCancel={() => { setActionTarget(null); setActionType(null); }}
            confirmLabel={actionType === "approve" ? "Approve" : "Reject"}
          >
            <p>{actionType === "approve" ? "Are you sure you want to approve" : "Are you sure you want to reject"}</p>
            <p className="admin-table__title">&ldquo;{actionTarget.title}&rdquo;?</p>
          </Dialog>
        )}
      </section>
    </AccessGate>
  );
}
