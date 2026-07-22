CREATE TYPE "knowledge_document_status" AS ENUM ('UPLOADED', 'PROCESSING', 'INDEXED', 'FAILED');

CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(160) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(500),
    "extracted_text" TEXT,
    "status" "knowledge_document_status" NOT NULL DEFAULT 'UPLOADED',
    "processing_error" VARCHAR(500),
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by_user_id" UUID NOT NULL,
    "indexed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "page_number" INTEGER,
    "section_title" VARCHAR(255),
    "embedding_json" JSONB,
    "embedding_model" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_documents_organization_id_status_idx"
ON "knowledge_documents"("organization_id", "status");
CREATE INDEX "knowledge_documents_organization_id_created_at_idx"
ON "knowledge_documents"("organization_id", "created_at");
CREATE INDEX "knowledge_documents_organization_id_deleted_at_idx"
ON "knowledge_documents"("organization_id", "deleted_at");
CREATE UNIQUE INDEX "knowledge_chunks_document_id_chunk_index_key"
ON "knowledge_chunks"("document_id", "chunk_index");
CREATE INDEX "knowledge_chunks_organization_id_document_id_idx"
ON "knowledge_chunks"("organization_id", "document_id");
CREATE INDEX "knowledge_chunks_organization_id_created_at_idx"
ON "knowledge_chunks"("organization_id", "created_at");

ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_uploaded_by_user_id_fkey"
FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_document_id_fkey"
FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
