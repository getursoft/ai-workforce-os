export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

export interface ApprovalRequestData {
  id: string;
  organizationId: string;
  workflowExecutionId: string;
  agentId: string;
  requestedBy: string;
  status: ApprovalStatus;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  comments: ApprovalComment[];
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

export interface CreateApprovalRequestInput {
  organizationId: string;
  workflowExecutionId: string;
  agentId: string;
  requestedBy: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
}

export interface ApproveInput {
  approvalRequestId: string;
  organizationId: string;
  approvedBy: string;
  comment?: string;
}

export interface RejectInput {
  approvalRequestId: string;
  organizationId: string;
  rejectedBy: string;
  comment?: string;
}
