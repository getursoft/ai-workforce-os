-- CreateTable
CREATE TABLE "employee_delegation_joins" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "correlation_id" VARCHAR(120) NOT NULL,
    "source_employee_installation_id" UUID NOT NULL,
    "parent_workflow_execution_id" UUID,
    "join_policy" VARCHAR(20) NOT NULL,
    "minimum_required" INTEGER,
    "total_children" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "resolved_reason" VARCHAR(40),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_delegation_joins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_delegation_joins_correlation_id_key" ON "employee_delegation_joins"("correlation_id");

-- CreateIndex
CREATE INDEX "employee_delegation_joins_organization_id_status_idx" ON "employee_delegation_joins"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "employee_delegation_joins" ADD CONSTRAINT "employee_delegation_joins_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
