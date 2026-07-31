-- CreateTable
CREATE TABLE "payment_gateway_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "gateway" VARCHAR(20) NOT NULL DEFAULT 'RAZORPAY',
    "configuration" JSONB NOT NULL,
    "encrypted_secrets" JSONB NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateway_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_configurations_organization_id_gateway_key" ON "payment_gateway_configurations"("organization_id", "gateway");

-- AddForeignKey
ALTER TABLE "payment_gateway_configurations" ADD CONSTRAINT "payment_gateway_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_gateway_configurations" ADD CONSTRAINT "payment_gateway_configurations_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
