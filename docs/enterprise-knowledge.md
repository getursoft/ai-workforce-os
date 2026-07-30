# Sprint 4.3 — Employee-Scoped Knowledge and Grounded RAG

> Supersedes the Sprint 4.1 design below. Sprint 4.1 UAT found that even though upload, chunking,
> embedding, indexing, and retrieval all worked, AI Employee responses ignored the retrieved
> knowledge entirely, and knowledge was shared organization-wide instead of per AI Employee. This
> revision introduces per-employee knowledge isolation and fixes the response-generation path so
> retrieved knowledge is actually used.

## Knowledge hierarchy

```text
Organization
  -> AI Employee (a Plugin installation)
    -> KnowledgeCollection (e.g. "Visa Rules", "Refund Rules", "Leave Policy")
      -> KnowledgeDocument
        -> KnowledgeChunk
```

Every `KnowledgeDocument` belongs to exactly one `KnowledgeCollection`, and every collection belongs
to exactly one AI Employee. `KnowledgeChunk` additionally denormalizes `pluginInstallationId` (the
owning employee) and `collectionId` directly onto the chunk row, so retrieval filters by employee
with a single indexed predicate instead of a join — a chunk can never be a search candidate for any
employee other than the one that owns its collection. There is no organization-wide knowledge view;
every read/write API is nested under an AI Employee id.

Retrieval always filters by `organizationId` **and** `pluginInstallationId` before the vector search
runs (see `KnowledgeSearchService.search` in `apps/api/src/knowledge/knowledge.search.ts`), with an
optional `collectionId` / `documentIds` narrowing on top.

## Supported documents

- PDF (`application/pdf`)
- DOCX
- UTF-8 TXT
- Markdown

Uploads are limited to 10 MB by default. Files are stored beneath a server-controlled,
tenant-aware storage root using generated document IDs. Original filenames are display metadata
only and are never used as filesystem paths.

## Chunking

Chunks preserve headings and never split a table. Markdown ATX headings (`#`..`######`) are tracked
as a heading stack; for PDF/DOCX/plain text (which have no markup left after extraction — see
`knowledge.extractors.ts`), a short, punctuation-free standalone line is heuristically treated as a
heading. Markdown table rows (`| a | b |`) are grouped into one table chunk regardless of size —
tables are never split, and non-markdown tabular layouts do not currently survive extraction (a known
limitation, see below). Each chunk stores `heading`, `sectionTitle`, `pageNumber` (from page-aware
extractors), `isTable`, and a `metadata` JSON blob (currently `{ isTable, headingPath }`).

Chunk size and overlap are configurable but clamped to 400-600 target tokens / 80-120 overlap tokens
(`KnowledgeChunkingService`, `apps/api/src/knowledge/knowledge.chunking.ts`) — an out-of-range
configured value is silently clamped into range rather than rejected, so production config drift
can't silently produce degenerate chunk sizes.

## Embedding and vector search

Embeddings are stored in a real pgvector column (`KnowledgeChunk.embedding vector(1536)`), queried
via cosine distance (`<=>`) with an HNSW index (`knowledge_chunks_embedding_hnsw_idx`). Prisma has no
native vector type, so both writes (`knowledge.service.ts`, `$executeRaw`) and reads
(`knowledge.search.ts`, `$queryRaw` with `Prisma.sql` — always parameterized, never string-built) go
around the generated client for that one column.

**Every embedding provider is standardized at 1536 dimensions** (`KNOWLEDGE_EMBEDDING_DIMENSIONS` in
`knowledge.embedding.ts`) — the OpenAI/Azure `text-embedding-3-small` width — including the
deterministic dev/test provider, so every provider type can write into the same pgvector column. A
configured embedding model that returns a different width fails fast with
`EMBEDDING_PROVIDER_DIMENSION_MISMATCH` instead of corrupting the index.

The embedding provider is resolved from **the specific AI Employee's own** `PluginAiConfiguration`
(`pluginInstallationId`-scoped), not "whichever plugin in the organization was configured most
recently" as in Sprint 4.1 — two employees in the same organization may use entirely different
embedding providers.

### Requires the pgvector Postgres extension

`docker-compose.yml` now runs `pgvector/pgvector:pg16` instead of `postgres:16-alpine` — the plain
Alpine image cannot install the `vector` extension. **This requires recreating the local Postgres
container and its data volume** (`docker compose down -v && docker compose up -d`); the Alpine
(musl) and Debian (glibc) images are not on-disk compatible, so an in-place image swap is not
possible. After recreating, run `pnpm run db:migrate` and re-seed RBAC (`pnpm exec prisma db seed`).

Any `KnowledgeDocument` indexed before this migration has its chunk text, metadata, and structure
fully preserved but its embedding is `NULL` until re-indexed (the old 64-dimension deterministic
`embedding_json` values are not meaningfully convertible to 1536 dimensions) — call
`POST /knowledge/documents/:id/reindex` for each pre-existing document after migrating.

## Relevance ranking

Ranking blends several signals into one score (`SCORE_WEIGHTS` in `knowledge.search.ts`):

| Signal              | Weight | What it measures                                                              |
| -------------------- | ------ | ------------------------------------------------------------------------------ |
| Semantic similarity  | 0.45   | Cosine similarity between the query and chunk embeddings                       |
| Keyword overlap      | 0.15   | Fraction of query terms present in the chunk content                           |
| Title boost          | 0.10   | Fraction of query terms present in the document title                          |
| Metadata boost       | 0.20   | Fraction of query terms present in the chunk's full heading path (see below)   |
| Exact phrase boost   | 0.10   | Whether the query appears verbatim in the heading path or content              |
| Conflict penalty     | −0.35  | Subtracted when the query's intent conflicts with the heading (see below)      |

This is what lets a chunk that literally states "Travix India Private Limited" outrank a merely
topically-similar one for "what is your company name" — especially important against the
deterministic (non-neural) embedding provider used in dev/test, whose vectors are coarse hash
buckets rather than a trained semantic space, so keyword/title signals carry real weight in practice.

Top-K and the similarity threshold are configurable via `KNOWLEDGE_SEARCH_DEFAULT_TOP_K` /
`KNOWLEDGE_SEARCH_MAX_TOP_K` / `KNOWLEDGE_SEARCH_DEFAULT_SCORE_THRESHOLD`, with a per-request override
on `POST /knowledge/employees/:employeeId/search` (bounded by the configured max). This retrieval
threshold is intentionally lower than the response-generation confidence gate below — it keeps enough
recall for section-summary aggregation to have real sibling chunks to work with.

### Query normalization

Before ranking (not before embedding — the embedding call always uses the raw query, since the
provider/contract is out of scope for this), `normalizeQueryText` in `knowledge.search.ts` lowercases
the query, drops a small curated set of Hinglish filler words ("phle", "btao", "kya", ...), and corrects
a query word to a known vocabulary term when it is a single edit away (e.g. "cancelation" ->
"cancellation") — deterministic, no translation service or extra LLM call.

### Query-intent term groups

A small set of reusable term groups (`TERM_GROUPS` in `knowledge.search.ts`) — cancellation/refund,
fare/pricing/discount, infant/child, age/eligibility, hotel/accommodation, booking/reservation — let two
different words in the same group count as a match (e.g. "kid" ~ "child") for keyword/title/metadata
overlap, on top of the existing prefix-based stemming. They also drive one directional conflict rule: a
query with fare/pricing intent strongly penalizes (and, in response generation, rejects) a heading that
reads as cancellation-only — this is what stops "how kids fare is calculated" from answering out of
"Cancellation/Changes for Infant Bookings" just because that heading also mentions "infant". The hotel
and booking groups exist purely as *narrowing attributes* for `isBroadInfantChildQuery` below (fare, age,
cancellation, hotel, or booking alongside "infant"/"child" makes a query specific, not broad).

### Broad infant/child detection and parent-topic alignment

A bare infant/child-topic query with no narrower attribute — "where is kids policy", "infants", "tell me
about children" — is a section-summary request (`isBroadInfantChildQuery`) even without the word
"policy"/"rules" at all; the moment a narrowing attribute (fare, age, cancellation, hotel, booking) is
present, it resolves to one specific subsection instead ("infant fare", "infant age", "infant
cancellation"). The section-summary anchor is never taken on faith from `sources[0]`: `trySectionSummary`
in `knowledge.prompt.ts` walks the ranked list for the first chunk whose own *parent heading* (not body
content) aligns with the query's term groups, so a chunk whose body happens to mention "children" but
whose actual parent section is "Group Booking Policy" can never become the anchor for "kids policy".

### Document roles and the Document Quality Filter

`classifyDocumentRole` in `knowledge.search.ts` structurally classifies a chunk's own (leaf) heading —
never the ancestor path, so a real policy section nested under an "Appendix" heading isn't penalized
just because an ancestor says so — into `INTRODUCTION`, `METADATA`, `TABLE_OF_CONTENTS`, `APPENDIX`,
`INTERNAL_NOTE`, or `SECTION`. The pattern list is purely generic document-genre vocabulary
("introduction", "table of contents", "appendix", "version history", "note for AI/implementation team",
...) — never a business/policy name — so it applies unchanged to any future AI Employee's documents.
Ranking (`documentRolePenalty` in `SCORE_WEIGHTS`) heavily penalizes anything that isn't `SECTION`, and
the response-generation confidence gate (`isNonPolicyDocumentRole`, see below) rejects it outright
regardless of score — this is what stops an unsupported/unmatched query from ever falling back to "the
document introduction" merely because nothing else scored as high.

### Leaf-heading precision

`metadataBoost` blends the *full* ancestor path, so every sibling under "2. Cancellation Policy" gets
equal credit for the shared word "cancellation" — useful for section-level relevance, but unable to tell
two siblings apart. `leafHeadingBoost` is a second, independent signal that matches only the chunk's own
most-specific heading, so a distinctive word appearing there (e.g. "Airline" in "2.4 Cancellation by
Supplier (Airline/Hotel-Initiated)") discriminates that one subsection from a same-parent sibling like
"Force Majeure" even when the sibling has a semantic-similarity edge.

### Confidence gating / Response Validator (response generation)

`buildKnowledgeAnswer` in `knowledge.prompt.ts` never renders an answer (single-chunk or
section-summary) from a candidate that fails `isConfidentAnswer`, which checks, in order: confidence
sufficient (score above `MIN_ANSWER_SCORE`, a stricter floor than the retrieval-recall threshold above),
not the fare-vs-cancellation heading conflict, real policy content (not `isNonPolicyDocumentRole`), and
section-heading match (`headingPathMatchesQueryIntent` covers every term group the query touches). The
single-chunk path walks past a candidate that fails this gate to the next-best confident one rather than
giving up immediately — only when nothing in the result set is confident does it return the grounded
"I could not find this information in the uploaded knowledge." message.

### Response Formatter

A chunk's raw content is never exposed verbatim when it's a markdown table: `formatSourceContent` in
`knowledge.prompt.ts` detects `isTable` chunks and converts the parsed table (`tableToNaturalLanguage`,
a purely structural pipe-table parser — never document-specific) into short "Header: value" sentences,
one per row, instead of dumping `| Days | Refund |` syntax into the answer. Citations (heading/source/
page lines) are built separately and are never affected.

### Request classification and routing

`apps/api/src/agents/request-classifier.ts` is the single central classifier for every inbound message,
reused by every current and future AI Employee. `classifyRequestIntent` returns one of `KNOWLEDGE_QUERY`,
`TASK_EXECUTION`, `TRAVEL_PLANNING`, `SLOT_UPDATE`, `CONFIRMATION`, `CORRECTION`, `GENERAL_CHAT`, or
`UNKNOWN` — computed from the current message's text alone, never from whether `knowledge.search`
returned anything or how well it scored. Domain (today: Travel Employee) signals are checked first and
always win over incidental policy-vocabulary overlap (e.g. "travel" appearing in both "travel policy"
and "i want to travel delhi to mumbai"). `AgentService.execute` only ever lets the central
grounded-answer bypass fire — and only it may return "I could not find this information in the uploaded
knowledge." — via `isKnowledgeEligible(requestIntent)`, i.e. exactly `KNOWLEDGE_QUERY`; every other
category continues through the employee's normal provider/tool workflow unconditionally, so
"i want to travel delhi to mumbai on 10 dec 26" is never hijacked by a low-relevance knowledge chunk.
Knowledge search still runs on every turn for prompt context/diagnostics regardless of classification.

## Prompt construction and grounding

Every AI Employee — travel or otherwise — is assembled through the same order (`PromptBuilder` in
`apps/api/src/agents/agent.runtime.ts`):

```text
System (EMPLOYEE_SYSTEM_IDENTITY_PROMPT, shared by every employee)
  -> Employee Identity (org prompt + this employee's configured persona)
    -> Retrieved Knowledge
      -> Conversation (memories + prior turns)
        -> User (the current message)
```

Retrieved knowledge is placed before conversation history so it can never be "buried" behind (and
therefore outweighed by) prior turns.

**Grounding is enforced structurally, not just by instruction.** `AgentService.execute` (see
`knowledgeGroundedAnswer` in `apps/api/src/agents/agent.service.ts`) renders every turn where
retrieval returns qualifying sources through a deterministic **Answer / Supporting policy / Source /
Confidence** template (`buildKnowledgeAnswer` in `knowledge.prompt.ts`), instead of trusting free-form
model prose to follow that structure or to actually prefer the retrieved text over its own pretrained
knowledge. This is unconditional and provider-agnostic: it applies the same way whether the employee
is backed by the deterministic dev provider or a real OpenAI/Azure model, and it is what fixed the
Sprint 4.1 defect where the Travel Employee's response-generation calls received the retrieved
knowledge in their prompt but never actually read it.

**Section-summary answers.** A query asking for an entire policy/section — a named topic like
"cancellation policy" / "refund policy" / "baggage policy", or a broad "tell me about" / "explain" /
"what is" prefix (see `isSectionSummaryQuery` in `knowledge.prompt.ts`) — is answered from every
top-ranked chunk that shares a real parent section (via `metadata.headingPath`, see `trySectionSummary`),
not just `sources[0]`, so "what is the cancellation policy" summarizes every subsection (scope,
windows, customer/supplier cancellation, no-show, refund timeline) instead of whichever single
subsection happened to score highest. A specific question ("what happens if the airline cancels",
"refund timeline") still resolves to one subsection exactly as before — the merge only fires when the
top-ranked chunks are genuine siblings at least two heading levels deep (never the bare document-root
heading alone, which would otherwise wrongly merge unrelated top-level sections, e.g. "Company Name"
and "Portal Benefits", that merely happen to share a document title).

When no source qualifies but the message explicitly names another AI Employee's domain (e.g. "leave
policy", "payroll", "invoice" — see `namesOtherEmployeeDomain`), the employee replies with the fixed
message below rather than drifting into unrelated conversation or a task flow that was never meant to
answer it. This is deliberately narrow (multi-word, unambiguous phrases only) so a generic AI
Employee remains free to hold ordinary conversation, including general-knowledge questions its
configured provider can answer, when nothing in the turn names another employee's specific domain.

> I could not find this information in the uploaded knowledge.

## Retrieval debug logging

Set `KNOWLEDGE_RETRIEVAL_DEBUG_LOGGING=true` to log, per turn: the user query, retrieved documents,
similarity scores, selected chunk ids (`KNOWLEDGE_RETRIEVAL_DEBUG` in `knowledge.search.ts`), and
prompt length/tokens, a preview of the final prompt, and the model's response
(`AGENT_PROMPT_DEBUG` in `agent.service.ts`). Off by default; when on, `KnowledgeSource` responses
also include a `scoreBreakdown` (semantic/keywordOverlap/titleBoost/metadataBoost) on a per-request
basis via `debug: true` in the search body. None of this is logged with raw secrets or full document
text beyond the already-public chunk content.

## API

- `POST /api/v1/knowledge/employees/:employeeId/collections` — create a knowledge collection
- `GET /api/v1/knowledge/employees/:employeeId/collections` — list an employee's collections
- `PATCH /api/v1/knowledge/collections/:id` — rename/update a collection
- `DELETE /api/v1/knowledge/collections/:id` — delete an empty, non-default collection
- `POST /api/v1/knowledge/employees/:employeeId/collections/:collectionId/documents` — multipart
  upload and bounded synchronous indexing
- `GET /api/v1/knowledge/employees/:employeeId/documents` — paginated document list for one employee
- `GET /api/v1/knowledge/documents/:id` — metadata and chunk previews
- `POST /api/v1/knowledge/documents/:id/reindex` — replace existing chunks
- `DELETE /api/v1/knowledge/documents/:id` — soft delete and remove searchable chunks
- `POST /api/v1/knowledge/employees/:employeeId/search` — employee-scoped hybrid search

Normal responses never contain embeddings, storage paths, provider secrets, or extracted full
document text.

## Manual verification

1. Recreate the local Postgres container against the new `pgvector/pgvector:pg16` image (see above),
   run migrations, and seed RBAC.
2. Install two AI Employees in one organization (e.g. Travel Employee and a second, generic
   installation) and create one knowledge collection per employee.
3. Open `/knowledge`, select the Travel Employee, upload a small travel-policy document containing a
   company name and a cancellation policy.
4. Confirm the document reaches `INDEXED`, then ask the Travel Employee "What is your company name?"
   and confirm the response is grounded in the uploaded document (Answer / Supporting policy /
   Source / Confidence), not a generic reply.
5. Ask the Travel Employee a question naming the other employee's domain (e.g. "What is the leave
   policy?") and confirm it explicitly states the knowledge is unavailable rather than guessing.
6. Ask the second employee the same domain question with its own matching document uploaded, and
   confirm it answers correctly — proving isolation holds in both directions.

## Current limitations

- No OCR; scanned image-only PDFs fail with `KNOWLEDGE_TEXT_NOT_EXTRACTABLE`.
- Indexing is synchronous and bounded; a background job queue is deferred.
- Local filesystem storage is the MVP adapter; shared deployments should provide durable shared
  storage before horizontally scaling the API.
- Non-markdown tabular layouts (scanned/PDF/DOCX tables) do not survive text extraction as structured
  tables today — "do not split tables" is fully honored for markdown source documents only.
- The "no knowledge available" cross-employee-domain detector is a small, curated phrase list
  (`namesOtherEmployeeDomain`), not a general classifier — it will not catch every possible way of
  asking about another employee's domain, by design (a broad "any question word" heuristic was tried
  and rejected: it incorrectly blocked ordinary conversation and general-knowledge questions).
- Prompt-injection defenses reduce risk but do not eliminate it.
- The no-op virus scanner is an explicit extension point and does not claim to scan files.
