"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-provider";
import { useEffectivePermissions } from "../../admin/authorization";
import { createApprovalApi, type ApprovalRequestData, type ApprovalStatus } from "./approval-api";
import {
  Alert, Badge, Button, Card, Dialog, EmptyState, PageHeader, Skeleton,
} from "../../../components/ui";

function useApi() {
  const { client, state } = useAuth();
  const orgId = state.organization?.id ?? "";
  const userId = state.user?.id ?? "";
  return useMemo(
    () => ({ api: createApprovalApi(client, orgId, userId), orgId, userId }),
    [client, orgId, userId]
  );
}

function StatusBadge({ status }: { status: ApprovalStatus }) {
  const tones: Record<string, "success" | "warning" | "danger" | "neutral"> = {
    PENDING: "warning",
    APPROVED: "success",
    REJECTED: "danger",
    CHANGES_REQUESTED: "neutral",
    EXPIRED: "neutral",
    CANCELLED: "neutral",
    SUPERSEDED: "neutral",
  };
  return <Badge tone={tones[status] ?? "neutral"}>{status}</Badge>;
}

export function ApprovalInboxPage() {
  const { api } = useApi();
  const permissions = useEffectivePermissions();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("PENDING");
  const [selected, setSelected] = useState<ApprovalRequestData | null>(null);
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");

  const isApprover = permissions.has("approval.decide");

  const q = useQuery({
    queryKey: ["approvals", activeTab],
    queryFn: () =>
      activeTab === "PENDING"
        ? api.myPending()
        : api.list({ status: activeTab as ApprovalStatus }).then((r) => r.items),
  });

  const action = useMutation({
    mutationFn: async (vars: { id: string; action: "approve" | "reject"; comment?: string }) => {
      if (vars.action === "approve") return api.approve(vars.id, vars.comment);
      return api.reject(vars.id, vars.comment);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
      setActionType(null);
      setSelected(null);
      setComment("");
    },
  });

  const tabs = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"];
  if (permissions.has("approval.read")) tabs.push("ALL");

  return (
    <section className="admin-page">
      <PageHeader
        title="Approval Inbox"
        description="Review and manage approval requests."
      />
      {isApprover ? (
        <Card className="admin-toolbar" style={{ padding: "6px" }}>
          <div className="admin-tabs">
            {tabs.map((tab) => (
              <button
                key={tab}
                className={`admin-tab ${activeTab === tab ? "admin-tab--active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "ALL" ? "All" : tab.charAt(0) + tab.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </Card>
      ) : null}

      {q.isLoading ? (
        <Skeleton />
      ) : q.isError ? (
        <Alert tone="danger" title="Unable to load approvals" />
      ) : !q.data || (Array.isArray(q.data) && q.data.length === 0) ? (
        <EmptyState title="No approvals" description="No approval requests match the current filter." />
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Action Type</th>
                <th>Requester</th>
                <th>Approver Type</th>
                <th>Status</th>
                <th>Created</th>
                {isApprover ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {(Array.isArray(q.data) ? q.data : []).map((item: ApprovalRequestData) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </td>
                  <td><Badge>{item.actionType}</Badge></td>
                  <td>{item.requestedBy}</td>
                  <td><Badge>{item.approverType}</Badge></td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{new Date(item.createdAt).toLocaleDateString()}</td>
                  {isApprover ? (
                    <td>
                      {item.status === "PENDING" ? (
                        <div className="admin-actions">
                          <Button onClick={() => { setSelected(item); setActionType("approve"); }}>
                            Approve
                          </Button>
                          <Button variant="danger" onClick={() => { setSelected(item); setActionType("reject"); }}>
                            Reject
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && actionType ? (
        <Dialog
          open
          title={actionType === "approve" ? "Approve Request" : "Reject Request"}
          onConfirm={() =>       action.mutate({ id: selected.id, action: actionType, comment: comment || undefined } as never)}
          onCancel={() => { setActionType(null); setComment(""); }}
          confirmLabel={actionType === "approve" ? "Approve" : "Reject"}
        >
          <p>{actionType === "approve" ? "Are you sure you want to approve" : "Are you sure you want to reject"}</p>
          <p><strong>&ldquo;{selected.title}&rdquo;?</strong></p>
          <textarea
            className="ui-input"
            placeholder="Add a comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            style={{ width: "100%", marginTop: 12 }}
          />
        </Dialog>
      ) : null}
    </section>
  );
}
