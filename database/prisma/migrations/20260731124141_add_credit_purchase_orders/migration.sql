-- CreateTable
CREATE TABLE "credit_purchase_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "gateway" VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
    "gateway_order_id" VARCHAR(120),
    "gateway_payment_id" VARCHAR(120),
    "failure_reason" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "credit_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_purchase_orders_gateway_order_id_key" ON "credit_purchase_orders"("gateway_order_id");

-- CreateIndex
CREATE INDEX "credit_purchase_orders_organization_id_status_idx" ON "credit_purchase_orders"("organization_id", "status");

-- RenameForeignKey
ALTER TABLE "customer_support_employee_configurations" RENAME CONSTRAINT "customer_support_employee_configurations_created_by_user_id_fke" TO "customer_support_employee_configurations_created_by_user_i_fkey";

-- RenameForeignKey
ALTER TABLE "customer_support_employee_configurations" RENAME CONSTRAINT "customer_support_employee_configurations_plugin_installation_id" TO "customer_support_employee_configurations_plugin_installati_fkey";

-- AddForeignKey
ALTER TABLE "credit_purchase_orders" ADD CONSTRAINT "credit_purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_purchase_orders" ADD CONSTRAINT "credit_purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "conversation_attachments_organization_id_conversation_id_create" RENAME TO "conversation_attachments_organization_id_conversation_id_cr_idx";

-- RenameIndex
ALTER INDEX "customer_support_employee_configurations_plugin_installation_id" RENAME TO "customer_support_employee_configurations_plugin_installatio_key";
