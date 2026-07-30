-- Sprint 4.4: Human Approval
-- Adds WAITING_FOR_APPROVAL workflow status, ApprovalStatus enum, and ApprovalRequest model.

ALTER TYPE "workflow_status" ADD VALUE 'WAITING_FOR_APPROVAL';

CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "approval_requests" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "organization_id" uuid NOT NULL,
    "workflow_execution_id" uuid NOT NULL,
    "agent_id" uuid NOT NULL,
    "requested_by" varchar(200) NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "title" varchar(300) NOT NULL,
    "description" text NOT NULL,
    "payload" jsonb NOT NULL DEFAULT '{}',
    "comments" jsonb NOT NULL DEFAULT '[]',
    "approved_at" timestamp(3) with time zone,
    "approved_by" varchar(200),
    "created_at" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp(3) with time zone NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "approval_requests_org_status_created_idx" ON "approval_requests"("organization_id", "status", "created_at");
CREATE INDEX "approval_requests_workflow_execution_idx" ON "approval_requests"("workflow_execution_id");

ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "approval_requests"
    ADD CONSTRAINT "approval_requests_workflow_execution_fkey"
    FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id") ON DELETE CASCADE;
