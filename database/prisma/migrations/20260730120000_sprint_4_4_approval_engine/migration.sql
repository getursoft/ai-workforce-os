-- CreateEnum
CREATE TYPE "approver_type" AS ENUM ('CUSTOMER', 'EMPLOYEE', 'MANAGER', 'ORGANISATION_ADMIN', 'FINANCE_APPROVER', 'HR_APPROVER', 'SYSTEM_OWNER', 'SPECIFIC_USER', 'SPECIFIC_ROLE', 'EXTERNAL_CONTACT', 'MULTI_APPROVER');

-- CreateEnum
CREATE TYPE "approval_mode" AS ENUM ('SINGLE', 'ANY_ONE', 'ALL', 'SEQUENTIAL', 'THRESHOLD', 'CUSTOMER_CONFIRMATION');

-- CreateEnum
CREATE TYPE "approval_decision_type" AS ENUM ('APPROVE', 'REJECT', 'REQUEST_CHANGES', 'WITHDRAW', 'CANCEL', 'ESCALATE');

-- CreateEnum
CREATE TYPE "travel_booking_status" AS ENUM ('DRAFT', 'OPTIONS_PREPARED', 'WAITING_FOR_CUSTOMER_APPROVAL', 'CUSTOMER_APPROVED', 'BOOKING_REQUEST_GENERATED', 'BOOKING_IN_PROGRESS', 'BOOKED', 'TICKETS_DELIVERED', 'CUSTOMER_REJECTED', 'CUSTOMER_REQUESTED_CHANGES', 'APPROVAL_EXPIRED', 'BOOKING_FAILED');

-- CreateEnum
CREATE TYPE "travel_cancellation_status" AS ENUM ('CANCELLATION_REQUESTED_BY_CUSTOMER', 'CANCELLATION_QUOTE_PREPARED', 'WAITING_FOR_MANAGER_APPROVAL', 'MANAGER_APPROVED', 'CANCELLATION_IN_PROGRESS', 'CANCELLED', 'REFUND_IN_PROGRESS', 'REFUNDED', 'MANAGER_REJECTED', 'CUSTOMER_WITHDREW_REQUEST', 'CANCELLATION_FAILED', 'PARTIALLY_REFUNDED', 'NON_REFUNDABLE', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "hr_leave_status" AS ENUM ('DRAFT', 'SUBMITTED_BY_EMPLOYEE', 'WAITING_FOR_MANAGER_APPROVAL', 'MANAGER_APPROVED', 'SUBMITTED_TO_HR_SYSTEM', 'RECORDED', 'MANAGER_REJECTED', 'MANAGER_REQUESTED_CHANGES', 'EMPLOYEE_WITHDREW', 'HR_SUBMISSION_FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "approval_status" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "approval_status" ADD VALUE 'CANCELLED';
ALTER TYPE "approval_status" ADD VALUE 'SUPERSEDED';

-- AlterEnum
ALTER TYPE "workflow_status" ADD VALUE 'RESUMING';

-- AlterTable
ALTER TABLE "approval_requests" ADD COLUMN     "action_type" VARCHAR(60) NOT NULL,
ADD COLUMN     "approver_type" "approver_type" NOT NULL,
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "idempotency_key" VARCHAR(500),
ADD COLUMN     "payload_snapshot_json" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "policy_id" UUID,
ADD COLUMN     "requester_external_id" VARCHAR(200),
ADD COLUMN     "requester_type" VARCHAR(40) NOT NULL DEFAULT 'EMPLOYEE',
ADD COLUMN     "requester_user_id" UUID,
ADD COLUMN     "resolved_at" TIMESTAMP(3),
ADD COLUMN     "subject_id" VARCHAR(120),
ADD COLUMN     "subject_type" VARCHAR(60),
ADD COLUMN     "superseded_by_id" UUID;

-- CreateTable
CREATE TABLE "approval_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "workflow_type" VARCHAR(60) NOT NULL,
    "action_type" VARCHAR(60) NOT NULL,
    "approver_type" "approver_type" NOT NULL,
    "mode" "approval_mode" NOT NULL,
    "minimum_approvals" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions_json" JSONB NOT NULL DEFAULT '{}',
    "reapproval_rules_json" JSONB NOT NULL DEFAULT '{}',
    "escalation_rules_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_assignments" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "approver_type" "approver_type" NOT NULL,
    "approver_user_id" UUID,
    "approver_role_key" VARCHAR(100),
    "external_contact_id" VARCHAR(200),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "approval_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "assignment_id" UUID,
    "decision" "approval_decision_type" NOT NULL,
    "actor_type" VARCHAR(40) NOT NULL,
    "actor_user_id" UUID,
    "actor_external_id" VARCHAR(200),
    "comment" TEXT,
    "decision_payload_json" JSONB NOT NULL DEFAULT '{}',
    "channel" VARCHAR(40) NOT NULL DEFAULT 'internal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "approval_request_id" UUID,
    "workflow_execution_id" UUID,
    "event_type" VARCHAR(80) NOT NULL,
    "actor_type" VARCHAR(40) NOT NULL,
    "actor_id" VARCHAR(200),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_bookings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "workflow_execution_id" UUID,
    "approval_request_id" UUID,
    "status" "travel_booking_status" NOT NULL DEFAULT 'DRAFT',
    "lead_id" UUID,
    "origin_city" VARCHAR(160),
    "destination_city" VARCHAR(160),
    "travel_dates" VARCHAR(160),
    "passengers" VARCHAR(80),
    "cabin_class" VARCHAR(40),
    "budget_amount" DECIMAL(12,2),
    "budget_currency" VARCHAR(8),
    "quoted_amount" DECIMAL(12,2),
    "quoted_currency" VARCHAR(8),
    "approved_amount" DECIMAL(12,2),
    "price_tolerance" DECIMAL(12,2),
    "selected_options_json" JSONB NOT NULL DEFAULT '[]',
    "flight_details_json" JSONB NOT NULL DEFAULT '{}',
    "hotel_details_json" JSONB NOT NULL DEFAULT '{}',
    "itinerary_json" JSONB NOT NULL DEFAULT '{}',
    "traveller_summary_json" JSONB NOT NULL DEFAULT '{}',
    "cancellation_terms" TEXT,
    "snapshot_json" JSONB NOT NULL DEFAULT '{}',
    "provider_booking_ref" VARCHAR(100),
    "provider_pnr" VARCHAR(20),
    "provider_status" VARCHAR(60),
    "provider_response_json" JSONB NOT NULL DEFAULT '{}',
    "ticket_numbers_json" JSONB NOT NULL DEFAULT '[]',
    "email_delivery_status" VARCHAR(40),
    "mobile_delivery_status" VARCHAR(40),
    "customer_email" VARCHAR(320),
    "customer_phone" VARCHAR(24),
    "idempotency_key" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "travel_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_cancellations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "workflow_execution_id" UUID,
    "approval_request_id" UUID,
    "status" "travel_cancellation_status" NOT NULL DEFAULT 'CANCELLATION_REQUESTED_BY_CUSTOMER',
    "requested_by_user_id" UUID,
    "requested_by_external_id" VARCHAR(200),
    "reason" TEXT,
    "cancellation_quote_json" JSONB NOT NULL DEFAULT '{}',
    "financial_impact_json" JSONB NOT NULL DEFAULT '{}',
    "provider_refund_ref" VARCHAR(100),
    "provider_response_json" JSONB NOT NULL DEFAULT '{}',
    "refund_amount" DECIMAL(12,2),
    "refund_currency" VARCHAR(8),
    "refund_status" VARCHAR(40),
    "idempotency_key" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "travel_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_leave_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "employee_user_id" UUID NOT NULL,
    "manager_user_id" UUID,
    "workflow_execution_id" UUID,
    "approval_request_id" UUID,
    "status" "hr_leave_status" NOT NULL DEFAULT 'DRAFT',
    "leave_type" VARCHAR(60) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "handover_details" TEXT,
    "supporting_doc_url" VARCHAR(500),
    "hr_system_reference" VARCHAR(100),
    "hr_system_response_json" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "hr_leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_policies_organization_id_workflow_type_action_type_idx" ON "approval_policies"("organization_id", "workflow_type", "action_type");

-- CreateIndex
CREATE UNIQUE INDEX "approval_policies_organization_id_key_key" ON "approval_policies"("organization_id", "key");

-- CreateIndex
CREATE INDEX "approval_assignments_approval_request_id_idx" ON "approval_assignments"("approval_request_id");

-- CreateIndex
CREATE INDEX "approval_assignments_approver_user_id_status_idx" ON "approval_assignments"("approver_user_id", "status");

-- CreateIndex
CREATE INDEX "approval_assignments_approver_role_key_status_idx" ON "approval_assignments"("approver_role_key", "status");

-- CreateIndex
CREATE INDEX "approval_assignments_external_contact_id_status_idx" ON "approval_assignments"("external_contact_id", "status");

-- CreateIndex
CREATE INDEX "approval_decisions_approval_request_id_idx" ON "approval_decisions"("approval_request_id");

-- CreateIndex
CREATE INDEX "approval_decisions_actor_user_id_idx" ON "approval_decisions"("actor_user_id");

-- CreateIndex
CREATE INDEX "approval_decisions_actor_external_id_idx" ON "approval_decisions"("actor_external_id");

-- CreateIndex
CREATE INDEX "approval_audit_events_organization_id_created_at_idx" ON "approval_audit_events"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_audit_events_approval_request_id_idx" ON "approval_audit_events"("approval_request_id");

-- CreateIndex
CREATE INDEX "approval_audit_events_workflow_execution_id_idx" ON "approval_audit_events"("workflow_execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "travel_bookings_idempotency_key_key" ON "travel_bookings"("idempotency_key");

-- CreateIndex
CREATE INDEX "travel_bookings_organization_id_status_created_at_idx" ON "travel_bookings"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "travel_bookings_conversation_id_idx" ON "travel_bookings"("conversation_id");

-- CreateIndex
CREATE INDEX "travel_bookings_approval_request_id_idx" ON "travel_bookings"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "travel_cancellations_idempotency_key_key" ON "travel_cancellations"("idempotency_key");

-- CreateIndex
CREATE INDEX "travel_cancellations_organization_id_status_created_at_idx" ON "travel_cancellations"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "travel_cancellations_booking_id_idx" ON "travel_cancellations"("booking_id");

-- CreateIndex
CREATE INDEX "travel_cancellations_approval_request_id_idx" ON "travel_cancellations"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_leave_requests_idempotency_key_key" ON "hr_leave_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "hr_leave_requests_organization_id_status_created_at_idx" ON "hr_leave_requests"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "hr_leave_requests_employee_user_id_idx" ON "hr_leave_requests"("employee_user_id");

-- CreateIndex
CREATE INDEX "hr_leave_requests_manager_user_id_idx" ON "hr_leave_requests"("manager_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_requests_idempotency_key_key" ON "approval_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "approval_requests_policy_id_idx" ON "approval_requests"("policy_id");

-- CreateIndex
CREATE INDEX "approval_requests_requester_user_id_idx" ON "approval_requests"("requester_user_id");

-- CreateIndex
CREATE INDEX "approval_requests_idempotency_key_idx" ON "approval_requests"("idempotency_key");

-- AddForeignKey
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "approval_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_assignments" ADD CONSTRAINT "approval_assignments_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "approval_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_audit_events" ADD CONSTRAINT "approval_audit_events_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_audit_events" ADD CONSTRAINT "approval_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_bookings" ADD CONSTRAINT "travel_bookings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_bookings" ADD CONSTRAINT "travel_bookings_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_bookings" ADD CONSTRAINT "travel_bookings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_cancellations" ADD CONSTRAINT "travel_cancellations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_cancellations" ADD CONSTRAINT "travel_cancellations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "travel_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

