-- CreateEnum
CREATE TYPE "employee_delegated_task_status" AS ENUM ('CREATED', 'VALIDATING', 'QUEUED', 'RUNNING', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'REJECTED');

-- AlterEnum
ALTER TYPE "workflow_type" ADD VALUE 'EMPLOYEE_DELEGATION';

-- AlterTable
ALTER TABLE "employee_routing_profiles" ADD COLUMN     "accepted_input_schema_json" JSONB,
ADD COLUMN     "default_failure_behaviour" VARCHAR(40) NOT NULL DEFAULT 'FAIL_PARENT',
ADD COLUMN     "delegation_priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "enabled_for_delegation" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "maximum_execution_time_ms" INTEGER NOT NULL DEFAULT 30000,
ADD COLUMN     "output_schema_json" JSONB,
ADD COLUMN     "required_capabilities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "required_permissions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sensitive_actions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "supported_task_types" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "supports_asynchronous_delegation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supports_synchronous_delegation" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "employee_delegated_tasks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_execution_id" UUID,
    "parent_workflow_execution_id" UUID,
    "source_employee_installation_id" UUID NOT NULL,
    "target_employee_installation_id" UUID NOT NULL,
    "child_conversation_id" UUID,
    "approval_request_id" UUID,
    "requested_by_actor_type" VARCHAR(40) NOT NULL DEFAULT 'EMPLOYEE',
    "requested_by_actor_id" VARCHAR(200),
    "task_type" VARCHAR(80) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "instructions" TEXT NOT NULL,
    "input_payload_json" JSONB NOT NULL DEFAULT '{}',
    "expected_output_schema_json" JSONB,
    "result_payload_json" JSONB,
    "status" "employee_delegated_task_status" NOT NULL DEFAULT 'CREATED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" VARCHAR(500),
    "correlation_id" VARCHAR(120) NOT NULL,
    "causation_id" VARCHAR(120),
    "delegation_depth" INTEGER NOT NULL DEFAULT 0,
    "delegation_chain" JSONB NOT NULL DEFAULT '[]',
    "join_policy" VARCHAR(20),
    "mode" VARCHAR(20) NOT NULL DEFAULT 'SYNCHRONOUS',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 1,
    "timeout_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "error_code" VARCHAR(100),
    "error_message_safe" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_delegated_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workforce_collaboration_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "collaboration_enabled" BOOLEAN NOT NULL DEFAULT true,
    "maximum_delegation_depth" INTEGER NOT NULL DEFAULT 2,
    "maximum_tasks_per_parent_execution" INTEGER NOT NULL DEFAULT 10,
    "allowed_source_employee_ids" JSONB NOT NULL DEFAULT '[]',
    "allowed_target_employee_ids" JSONB NOT NULL DEFAULT '[]',
    "allowed_task_types" JSONB NOT NULL DEFAULT '[]',
    "cross_employee_memory_sharing_mode" VARCHAR(40) NOT NULL DEFAULT 'SELECTED_FACTS_ONLY',
    "require_approval_for_sensitive_delegation" BOOLEAN NOT NULL DEFAULT true,
    "delegation_timeout_ms" INTEGER NOT NULL DEFAULT 15000,
    "retry_limit" INTEGER NOT NULL DEFAULT 1,
    "allow_parallel_delegation" BOOLEAN NOT NULL DEFAULT true,
    "expose_delegation_to_user" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workforce_collaboration_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_delegated_tasks_idempotency_key_key" ON "employee_delegated_tasks"("idempotency_key");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_organization_id_status_idx" ON "employee_delegated_tasks"("organization_id", "status");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_source_employee_installation_id_cr_idx" ON "employee_delegated_tasks"("source_employee_installation_id", "created_at");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_target_employee_installation_id_st_idx" ON "employee_delegated_tasks"("target_employee_installation_id", "status");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_parent_workflow_execution_id_idx" ON "employee_delegated_tasks"("parent_workflow_execution_id");

-- CreateIndex
CREATE INDEX "employee_delegated_tasks_correlation_id_idx" ON "employee_delegated_tasks"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "workforce_collaboration_policies_organization_id_key" ON "workforce_collaboration_policies"("organization_id");

-- CreateIndex
CREATE INDEX "employee_routing_profiles_organization_id_enabled_for_deleg_idx" ON "employee_routing_profiles"("organization_id", "enabled_for_delegation");

-- AddForeignKey
ALTER TABLE "employee_delegated_tasks" ADD CONSTRAINT "employee_delegated_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workforce_collaboration_policies" ADD CONSTRAINT "workforce_collaboration_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
