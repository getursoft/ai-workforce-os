-- Sprint 4.3: employee-scoped knowledge + pgvector retrieval.
--
-- Prior state (Sprint 4.1): KnowledgeDocument/KnowledgeChunk were organization-scoped only, with
-- embeddings stored as JSONB and compared via application-level cosine similarity. This migration
-- introduces KnowledgeCollection (Organization -> AI Employee -> Collection -> Document -> Chunk),
-- denormalizes the owning employee onto every chunk so retrieval can filter by employee without a
-- join, and replaces embedding_json with a real pgvector column queried via ANN.
--
-- Embedding dimensionality is standardized at 1536 (OpenAI/Azure `text-embedding-3-small` width)
-- across every provider, including the deterministic dev/test provider — see
-- docs/enterprise-knowledge.md "Embedding dimensionality" and knowledge.embedding.ts. Existing
-- knowledge_chunks rows were embedded at 64 dimensions by the deterministic provider; those vectors
-- are not meaningfully convertible to 1536 dimensions, so embedding_json is dropped rather than
-- migrated in place. Any KnowledgeDocument indexed before this migration must be reindexed via
-- `POST /knowledge/documents/:id/reindex` to populate the new `embedding` column — its rows remain
-- fully intact (text, chunks, metadata) in the interim, they are simply unranked until reindexed.

CREATE EXTENSION IF NOT EXISTS vector;

-- 1. KnowledgeCollection: the new Organization -> AI Employee -> Collection scoping level.
CREATE TABLE "knowledge_collections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plugin_installation_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "domain" VARCHAR(80),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "knowledge_collections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_collections_plugin_installation_id_name_key"
ON "knowledge_collections"("plugin_installation_id", "name");
CREATE INDEX "knowledge_collections_org_plugin_installation_deleted_at_idx"
ON "knowledge_collections"("organization_id", "plugin_installation_id", "deleted_at");

ALTER TABLE "knowledge_collections"
ADD CONSTRAINT "knowledge_collections_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_collections"
ADD CONSTRAINT "knowledge_collections_plugin_installation_id_fkey"
FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill: one default collection per organization, owned by that organization's existing Travel
-- Employee plugin installation (the only AI Employee type that existed before this migration). Every
-- pre-existing KnowledgeDocument moves into its organization's default collection.
INSERT INTO "knowledge_collections" ("id", "organization_id", "plugin_installation_id", "name", "description", "domain", "is_default", "updated_at")
SELECT
    gen_random_uuid(),
    org_plugin.organization_id,
    org_plugin.plugin_id,
    'General Travel Knowledge',
    'Documents uploaded before per-employee knowledge scoping existed, migrated automatically to the Travel Employee.',
    'TRAVEL',
    true,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (kd.organization_id)
        kd.organization_id AS organization_id,
        p.id AS plugin_id
    FROM "knowledge_documents" kd
    JOIN "plugins" p
        ON p.organization_id = kd.organization_id
        AND p.slug = 'travel-employee'
        AND p.deleted_at IS NULL
    ORDER BY kd.organization_id, p.installed_at ASC
) AS org_plugin;

-- Fail loudly rather than silently orphaning documents: every organization with pre-existing
-- knowledge documents must have had an installed travel-employee plugin for the backfill above to
-- have a home for its rows. If this fires, resolve the affected organization manually before deploying.
DO $$
DECLARE
    orphaned_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO orphaned_count
    FROM "knowledge_documents" kd
    WHERE NOT EXISTS (
        SELECT 1 FROM "knowledge_collections" kc
        WHERE kc.organization_id = kd.organization_id AND kc.is_default = true
    );
    IF orphaned_count > 0 THEN
        RAISE EXCEPTION 'knowledge_employee_scoping_backfill: % knowledge_documents row(s) belong to an organization with no travel-employee plugin installation and cannot be assigned a default collection', orphaned_count;
    END IF;
END $$;

-- 3. KnowledgeDocument: attach to its organization's default collection, then require it going forward.
ALTER TABLE "knowledge_documents" ADD COLUMN "collection_id" UUID;

UPDATE "knowledge_documents" kd
SET "collection_id" = kc.id
FROM "knowledge_collections" kc
WHERE kc.organization_id = kd.organization_id AND kc.is_default = true;

ALTER TABLE "knowledge_documents" ALTER COLUMN "collection_id" SET NOT NULL;
ALTER TABLE "knowledge_documents"
ADD CONSTRAINT "knowledge_documents_collection_id_fkey"
FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "knowledge_documents_collection_id_status_deleted_at_idx"
ON "knowledge_documents"("collection_id", "status", "deleted_at");

-- 4. KnowledgeChunk: denormalize employee + collection, add structural chunk metadata, replace the
-- JSONB embedding with a real pgvector column.
ALTER TABLE "knowledge_chunks" ADD COLUMN "plugin_installation_id" UUID;
ALTER TABLE "knowledge_chunks" ADD COLUMN "collection_id" UUID;
ALTER TABLE "knowledge_chunks" ADD COLUMN "heading" VARCHAR(255);
ALTER TABLE "knowledge_chunks" ADD COLUMN "is_table" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "knowledge_chunks" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding" vector(1536);
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_dimensions" INTEGER;

UPDATE "knowledge_chunks" kc
SET "plugin_installation_id" = kd.plugin_installation_id_resolved,
    "collection_id" = kd.collection_id
FROM (
    SELECT d.id, d.collection_id, col.plugin_installation_id AS plugin_installation_id_resolved
    FROM "knowledge_documents" d
    JOIN "knowledge_collections" col ON col.id = d.collection_id
) AS kd
WHERE kc.document_id = kd.id;

ALTER TABLE "knowledge_chunks" ALTER COLUMN "plugin_installation_id" SET NOT NULL;
ALTER TABLE "knowledge_chunks" ALTER COLUMN "collection_id" SET NOT NULL;
ALTER TABLE "knowledge_chunks" DROP COLUMN "embedding_json";

ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_plugin_installation_id_fkey"
FOREIGN KEY ("plugin_installation_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunks"
ADD CONSTRAINT "knowledge_chunks_collection_id_fkey"
FOREIGN KEY ("collection_id") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "knowledge_chunks_plugin_installation_id_collection_id_idx"
ON "knowledge_chunks"("plugin_installation_id", "collection_id");

-- ANN index for cosine-distance retrieval (see knowledge.search.ts). Partial: only chunks that have
-- actually been embedded participate (pre-migration chunks are NULL until reindexed, see header note).
-- HNSW is used over IVFFlat because it does not require a representative data sample to train against
-- at CREATE INDEX time, which matters for a migration that may run against a mostly-empty table.
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx"
ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops)
WHERE "embedding" IS NOT NULL;
