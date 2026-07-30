-- CreateEnum
CREATE TYPE "customer_identity_type" AS ENUM ('PHONE', 'CRM_ID', 'PORTAL_USER', 'ANONYMOUS');

-- DropForeignKey
ALTER TABLE "knowledge_chunks" DROP CONSTRAINT "knowledge_chunks_collection_id_fkey";

-- DropForeignKey
ALTER TABLE "knowledge_chunks" DROP CONSTRAINT "knowledge_chunks_plugin_installation_id_fkey";

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "customer_profile_id" UUID;

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "identity_type" "customer_identity_type" NOT NULL,
    "external_id" VARCHAR(160) NOT NULL,
    "display_name" VARCHAR(160),
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "currency" VARCHAR(8),
    "language" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_profiles_organization_id_identity_type_idx" ON "customer_profiles"("organization_id", "identity_type");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_organization_id_identity_type_external_id_key" ON "customer_profiles"("organization_id", "identity_type", "external_id");

-- CreateIndex
CREATE INDEX "conversations_organization_id_customer_profile_id_idx" ON "conversations"("organization_id", "customer_profile_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_profile_id_fkey" FOREIGN KEY ("customer_profile_id") REFERENCES "customer_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "knowledge_collections_org_plugin_installation_deleted_at_idx" RENAME TO "knowledge_collections_organization_id_plugin_installation_i_idx";
