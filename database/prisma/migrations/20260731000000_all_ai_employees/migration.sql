-- CreateEnum
CREATE TYPE "hr_ticket_status" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "finance_record_status" AS ENUM ('NEW', 'CLASSIFIED', 'REPORTED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "it_support_ticket_status" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "sales_lead_status" AS ENUM ('NEW', 'QUALIFIED', 'CONTACTED', 'CONVERTED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "marketing_campaign_status" AS ENUM ('DRAFT', 'APPROVED', 'ACTIVE', 'COMPLETED', 'PAUSED');

-- CreateEnum
CREATE TYPE "legal_notice_status" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'DRAFT_READY', 'FILED', 'CLOSED');

-- CreateEnum
CREATE TYPE "customer_support_ticket_status" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ESCALATED');

-- CreateTable
CREATE TABLE "hr_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI HR assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "employee_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "topic" VARCHAR(160),
    "details" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "hr_ticket_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'HrEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI finance assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "topic" VARCHAR(160),
    "amount" DECIMAL(12,2),
    "currency" VARCHAR(8),
    "details" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "finance_record_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'FinanceEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_support_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI IT support assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_support_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "it_support_tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "employee_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "category" VARCHAR(120),
    "description" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "it_support_ticket_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'ItSupportEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "it_support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI sales assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_leads" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "interest" VARCHAR(160),
    "notes" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "sales_lead_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'SalesEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI marketing assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaigns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "campaign_name" VARCHAR(160),
    "channel" VARCHAR(60),
    "goals" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "marketing_campaign_status" NOT NULL DEFAULT 'DRAFT',
    "source" VARCHAR(60) NOT NULL DEFAULT 'MarketingEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI legal assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_notices" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "notice_type" VARCHAR(160),
    "deadline" VARCHAR(80),
    "summary" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "legal_notice_status" NOT NULL DEFAULT 'RECEIVED',
    "source" VARCHAR(60) NOT NULL DEFAULT 'LegalEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_support_employee_configurations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "persona" VARCHAR(2000) NOT NULL DEFAULT '',
    "welcome_message" VARCHAR(1000) NOT NULL DEFAULT 'Hi! I''m your AI customer support assistant. How can I help you today?',
    "business_hours_timezone" VARCHAR(64),
    "business_hours_start" VARCHAR(5),
    "business_hours_end" VARCHAR(5),
    "escalation_contact" VARCHAR(255) NOT NULL DEFAULT '',
    "brand_tone" VARCHAR(40) NOT NULL DEFAULT 'FRIENDLY',
    "default_currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "default_language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_support_employee_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_support_tickets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "reference" VARCHAR(20) NOT NULL,
    "customer_name" VARCHAR(160),
    "phone_number" VARCHAR(24) NOT NULL,
    "email" VARCHAR(160),
    "topic" VARCHAR(160),
    "description" TEXT,
    "conversation_summary" TEXT NOT NULL,
    "consent_given_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(300),
    "status" "customer_support_ticket_status" NOT NULL DEFAULT 'NEW',
    "source" VARCHAR(60) NOT NULL DEFAULT 'CustomerSupportEmployee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_employee_configurations_plugin_installation_id_key" ON "hr_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "hr_employee_configurations_organization_id_idx" ON "hr_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_tickets_reference_key" ON "hr_tickets"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "hr_tickets_idempotency_key_key" ON "hr_tickets"("idempotency_key");

-- CreateIndex
CREATE INDEX "hr_tickets_organization_id_status_created_at_idx" ON "hr_tickets"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "hr_tickets_conversation_id_idx" ON "hr_tickets"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_employee_configurations_plugin_installation_id_key" ON "finance_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "finance_employee_configurations_organization_id_idx" ON "finance_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_records_reference_key" ON "finance_records"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "finance_records_idempotency_key_key" ON "finance_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "finance_records_organization_id_status_created_at_idx" ON "finance_records"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "finance_records_conversation_id_idx" ON "finance_records"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "it_support_employee_configurations_plugin_installation_id_key" ON "it_support_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "it_support_employee_configurations_organization_id_idx" ON "it_support_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "it_support_tickets_reference_key" ON "it_support_tickets"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "it_support_tickets_idempotency_key_key" ON "it_support_tickets"("idempotency_key");

-- CreateIndex
CREATE INDEX "it_support_tickets_organization_id_status_created_at_idx" ON "it_support_tickets"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "it_support_tickets_conversation_id_idx" ON "it_support_tickets"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_employee_configurations_plugin_installation_id_key" ON "sales_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "sales_employee_configurations_organization_id_idx" ON "sales_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_leads_reference_key" ON "sales_leads"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "sales_leads_idempotency_key_key" ON "sales_leads"("idempotency_key");

-- CreateIndex
CREATE INDEX "sales_leads_organization_id_status_created_at_idx" ON "sales_leads"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "sales_leads_conversation_id_idx" ON "sales_leads"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_employee_configurations_plugin_installation_id_key" ON "marketing_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "marketing_employee_configurations_organization_id_idx" ON "marketing_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_reference_key" ON "marketing_campaigns"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_idempotency_key_key" ON "marketing_campaigns"("idempotency_key");

-- CreateIndex
CREATE INDEX "marketing_campaigns_organization_id_status_created_at_idx" ON "marketing_campaigns"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "marketing_campaigns_conversation_id_idx" ON "marketing_campaigns"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_employee_configurations_plugin_installation_id_key" ON "legal_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "legal_employee_configurations_organization_id_idx" ON "legal_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_notices_reference_key" ON "legal_notices"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "legal_notices_idempotency_key_key" ON "legal_notices"("idempotency_key");

-- CreateIndex
CREATE INDEX "legal_notices_organization_id_status_created_at_idx" ON "legal_notices"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "legal_notices_conversation_id_idx" ON "legal_notices"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_support_employee_configurations_plugin_installation_id_key" ON "customer_support_employee_configurations"("plugin_installation_id");

-- CreateIndex
CREATE INDEX "customer_support_employee_configurations_organization_id_idx" ON "customer_support_employee_configurations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_support_tickets_reference_key" ON "customer_support_tickets"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "customer_support_tickets_idempotency_key_key" ON "customer_support_tickets"("idempotency_key");

-- CreateIndex
CREATE INDEX "customer_support_tickets_organization_id_status_created_at_idx" ON "customer_support_tickets"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "customer_support_tickets_conversation_id_idx" ON "customer_support_tickets"("conversation_id");

-- AddForeignKey
ALTER TABLE "hr_employee_configurations" ADD CONSTRAINT "hr_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_employee_configurations" ADD CONSTRAINT "hr_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_employee_configurations" ADD CONSTRAINT "hr_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_tickets" ADD CONSTRAINT "hr_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_tickets" ADD CONSTRAINT "hr_tickets_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_tickets" ADD CONSTRAINT "hr_tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_employee_configurations" ADD CONSTRAINT "finance_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_employee_configurations" ADD CONSTRAINT "finance_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_employee_configurations" ADD CONSTRAINT "finance_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_records" ADD CONSTRAINT "finance_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_records" ADD CONSTRAINT "finance_records_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_records" ADD CONSTRAINT "finance_records_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_employee_configurations" ADD CONSTRAINT "it_support_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_employee_configurations" ADD CONSTRAINT "it_support_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_employee_configurations" ADD CONSTRAINT "it_support_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_tickets" ADD CONSTRAINT "it_support_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_tickets" ADD CONSTRAINT "it_support_tickets_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "it_support_tickets" ADD CONSTRAINT "it_support_tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_employee_configurations" ADD CONSTRAINT "sales_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_employee_configurations" ADD CONSTRAINT "sales_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_employee_configurations" ADD CONSTRAINT "sales_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_employee_configurations" ADD CONSTRAINT "marketing_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_employee_configurations" ADD CONSTRAINT "marketing_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_employee_configurations" ADD CONSTRAINT "marketing_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_employee_configurations" ADD CONSTRAINT "legal_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_employee_configurations" ADD CONSTRAINT "legal_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_employee_configurations" ADD CONSTRAINT "legal_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notices" ADD CONSTRAINT "legal_notices_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_employee_configurations" ADD CONSTRAINT "customer_support_employee_configurations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_employee_configurations" ADD CONSTRAINT "customer_support_employee_configurations_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_employee_configurations" ADD CONSTRAINT "customer_support_employee_configurations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_support_tickets" ADD CONSTRAINT "customer_support_tickets_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
