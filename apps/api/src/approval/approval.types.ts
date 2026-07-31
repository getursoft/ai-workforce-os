export interface ApprovalComment {
  author: string;
  text: string;
  createdAt: string;
}

export interface CreateApprovalDto {
  organizationId: string;
  workflowExecutionId: string;
  agentId: string;
  actionType: string;
  subjectType?: string;
  subjectId?: string;
  requestedBy: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
}

export interface ApproveRejectDto {
  organizationId: string;
  actorUserId: string;
  comment?: string;
}

export interface PublicApprovalActionDto {
  decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES";
  comment?: string;
  channel?: string;
}
