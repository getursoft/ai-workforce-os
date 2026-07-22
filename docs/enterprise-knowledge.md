# Sprint 4.1 — RAG and Enterprise Knowledge

AI Workforce OS stores organization-scoped knowledge documents, extracts their text, creates
overlapping chunks, embeds those chunks, and retrieves relevant excerpts before an AI employee
response. Retrieved text is treated as untrusted data and is never allowed to override system
instructions.

## Supported documents

- PDF (`application/pdf`)
- DOCX
- UTF-8 TXT
- Markdown

Uploads are limited to 10 MB by default. Files are stored beneath a server-controlled,
tenant-aware storage root using generated document IDs. Original filenames are display metadata
only and are never used as filesystem paths.

## Configuration

```env
KNOWLEDGE_STORAGE_PATH=./storage/knowledge
KNOWLEDGE_MAX_FILE_SIZE_MB=10
KNOWLEDGE_CHUNK_TARGET_TOKENS=800
KNOWLEDGE_CHUNK_OVERLAP_TOKENS=100
KNOWLEDGE_SEARCH_CANDIDATE_LIMIT=1000
```

OpenAI-compatible configurations may set `embeddingModel`; Azure OpenAI configurations may set
`embeddingDeployment`. Both reuse the encrypted API key already stored for the plugin AI
configuration. Development and test environments can use the deterministic embedding provider.
It performs no network access and is rejected where development implementations are disabled.

Embedding vectors are stored as JSON for Sprint 4.1. Search first applies organization, document
status, deletion, and optional document filters in PostgreSQL, loads a bounded candidate set, and
then applies cosine similarity. This keeps local/test PostgreSQL portable while retaining a clean
adapter boundary for a future pgvector implementation.

## API

- `POST /api/v1/knowledge/documents` — multipart upload and bounded synchronous indexing
- `GET /api/v1/knowledge/documents` — paginated document list
- `GET /api/v1/knowledge/documents/:id` — metadata and chunk previews
- `POST /api/v1/knowledge/documents/:id/reindex` — replace existing chunks
- `DELETE /api/v1/knowledge/documents/:id` — soft delete and remove searchable chunks
- `POST /api/v1/knowledge/search` — tenant-scoped semantic search

Normal responses never contain embeddings, storage paths, provider secrets, or extracted full
document text.

## Manual verification

1. Configure a plugin with the deterministic provider locally, or configure `embeddingModel` /
   `embeddingDeployment` for a real provider.
2. Open `/knowledge` and upload a small travel-policy TXT, Markdown, DOCX, or PDF.
3. Confirm that the document reaches `INDEXED`.
4. Search with:

   ```bash
   curl -X POST http://localhost:4000/api/v1/knowledge/search \
     -H "Authorization: Bearer <access-token>" \
     -H "Content-Type: application/json" \
     -d '{"query":"What is the business class policy?","topK":5,"scoreThreshold":0.2}'
   ```

5. Ask the Travel AI employee the same question and confirm that its response displays source
   references.

## Current limitations

- No OCR; scanned image-only PDFs fail with `KNOWLEDGE_TEXT_NOT_EXTRACTABLE`.
- Indexing is synchronous and bounded; a background job queue is deferred.
- Local filesystem storage is the MVP adapter; shared deployments should provide durable shared
  storage before horizontally scaling the API.
- Similarity is application-level cosine over bounded JSON vectors. pgvector is a future adapter.
- Prompt-injection defenses reduce risk but do not eliminate it.
- The no-op virus scanner is an explicit extension point and does not claim to scan files.
