-- CreateEnum
CREATE TYPE "travel_lead_status" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'CLOSED');

-- CreateTable
CREATE TABLE "travel_leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "departure_city" VARCHAR(160),
    "destination" VARCHAR(160),
    "travel_dates" VARCHAR(160),
    "passengers" VARCHAR(80),
    "budget_amount" DECIMAL(12,2),
    "budget_currency" VARCHAR(8),
    "conversation_summary" TEXT NOT NULL,
    "status" "travel_lead_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'TravelEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "travel_leads_reference_key" ON "travel_leads"("reference");

-- CreateIndex
CREATE INDEX "travel_leads_organization_id_status_created_at_idx" ON "travel_leads"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "travel_leads_conversation_id_idx" ON "travel_leads"("conversation_id");

-- AddForeignKey
ALTER TABLE "travel_leads" ADD CONSTRAINT "travel_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_leads" ADD CONSTRAINT "travel_leads_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_leads" ADD CONSTRAINT "travel_leads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
