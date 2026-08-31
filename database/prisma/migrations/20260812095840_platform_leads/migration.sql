-- CreateEnum
CREATE TYPE "platform_lead_scope" AS ENUM ('PLATFORM', 'TENANT');

-- CreateEnum
CREATE TYPE "platform_lead_source" AS ENUM ('WEBSITE_DEMO', 'CONTACT_SALES', 'CONTACT_US', 'WEBSITE_ENQUIRY', 'OTHER');

-- CreateEnum
CREATE TYPE "platform_lead_type" AS ENUM ('DEMO_REQUEST', 'SALES_ENQUIRY', 'GENERAL_ENQUIRY', 'OTHER');

-- CreateEnum
CREATE TYPE "platform_lead_status" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_SCHEDULED', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "platform_leads" (
    "id" UUID NOT NULL,
    "scope" "platform_lead_scope" NOT NULL DEFAULT 'PLATFORM',
    "source" "platform_lead_source" NOT NULL,
    "type" "platform_lead_type" NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "phone" VARCHAR(40),
    "company" VARCHAR(160),
    "requirement" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "preferred_demo_date" VARCHAR(60),
    "preferred_demo_time" VARCHAR(60),
    "timezone" VARCHAR(60),
    "status" "platform_lead_status" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_leads_scope_status_created_at_idx" ON "platform_leads"("scope", "status", "created_at");

-- CreateIndex
CREATE INDEX "platform_leads_scope_source_created_at_idx" ON "platform_leads"("scope", "source", "created_at");
