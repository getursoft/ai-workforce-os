-- AlterTable
ALTER TABLE "legal_employee_configurations" ADD COLUMN "default_country" VARCHAR(80) NOT NULL DEFAULT 'India';

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "title" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "mime_type" VARCHAR(80) NOT NULL DEFAULT 'application/pdf',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "legal_documents_organization_id_conversation_id_created_at_idx" ON "legal_documents"("organization_id", "conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_plugin_installation_id_fkey" FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
