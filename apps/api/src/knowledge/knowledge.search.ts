import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { KnowledgeDocumentStatus, Prisma } from "@prisma/client";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { KnowledgeSearchDto } from "./knowledge.dto";
import { KnowledgeEmbeddingService } from "./knowledge.embedding";
import type { KnowledgeSource } from "./knowledge.types";

/**
 * Hybrid ranking weights (see docs/enterprise-knowledge.md "Hybrid ranking"). Semantic similarity
 * carries the most weight since it is the only signal that generalizes to unseen phrasing, but
 * keyword/title/metadata/phrase overlap are what make a chunk that literally states "Travix India
 * Private Limited" outrank a merely topically-similar one for a query like "what is your company
 * name" — especially important against the deterministic (non-neural) embedding provider used in
 * dev/test, whose vectors are coarse hash buckets rather than a trained semantic space.
 *
 * `metadataBoost` and `exactPhraseBoost` are weighted well above a raw content-only keyword mention:
 * a chunk whose *heading path* (its own heading plus every ancestor heading, e.g. "2. Cancellation
 * Policy" > "2.2 Standard Cancellation Windows & Refund Tiers") matches the query is far stronger
 * evidence that the chunk IS the answer than a chunk that merely mentions the same words in passing
 * (e.g. an implementation note explaining that the retrieval pipeline should surface cancellation
 * content, which is not itself the cancellation content). Without this, a meta/instructional chunk
 * can outrank the real policy section purely on incidental word overlap.
 */
const SCORE_WEIGHTS = {
  semantic: 0.4,
  keywordOverlap: 0.15,
  titleBoost: 0.1,
  metadataBoost: 0.15,
  // Distinct from metadataBoost: metadataBoost blends the FULL ancestor path (so every sibling under
  // "2. Cancellation Policy" gets equal credit for the shared word "cancellation"), which can't tell
  // apart two siblings under the same parent. leafHeadingBoost matches only the chunk's OWN most-specific
  // heading, so a distinctive word appearing there (e.g. "Airline" in "2.4 Cancellation by Supplier
  // (Airline/Hotel-Initiated)") discriminates that one subsection from its siblings — this is what makes
  // "what happens if airline cancels" prefer 2.4 over a same-parent sibling like "Force Majeure".
  leafHeadingBoost: 0.15,
  exactPhraseBoost: 0.1,
  conflictPenalty: 0.35,
  // A non-SECTION chunk (introduction, metadata, table of contents, appendix, internal/AI note — see
  // `classifyDocumentRole`) is heavily penalized so it can win a candidate slot only when nothing else
  // remotely relevant exists, and knowledge.prompt.ts's confidence gate rejects it outright regardless.
  documentRolePenalty: 0.5
} as const;

interface CandidateRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  page_number: number | null;
  heading: string | null;
  section_title: string | null;
  is_table: boolean;
  metadata: unknown;
  document_title: string;
  collection_id: string;
  semantic: number;
}

@Injectable()
export class KnowledgeSearchService {
  private readonly logger = new Logger(KnowledgeSearchService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: KnowledgeEmbeddingService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    private readonly candidateLimit = 1000
  ) {}

  /**
   * `employeeId` (a Plugin installation id) is mandatory and is the sole tenant+employee boundary:
   * every predicate below filters by `organizationId` AND `pluginInstallationId` before the ANN
   * search ever runs, so a chunk belonging to a different AI Employee can never be a candidate row —
   * there is no filtering-after-the-fact step that could leak across employees.
   */
  async search(
    organizationId: string,
    employeeId: string,
    input: KnowledgeSearchDto
  ): Promise<KnowledgeSource[]> {
    const { sources } = await this.runSearch(organizationId, employeeId, input);
    return sources;
  }

  /** Sprint 4.7A Phase 6: identical retrieval/ranking as `search()` (delegates to the same private
   *  implementation — never a second, divergent copy of the scoring logic) but also returns the counts a
   *  KNOWLEDGE_SEARCH trace span needs. Never returns chunk content beyond what `search()` already would. */
  async searchWithMetrics(
    organizationId: string,
    employeeId: string,
    input: KnowledgeSearchDto
  ): Promise<{ sources: KnowledgeSource[]; metrics: KnowledgeSearchMetrics }> {
    return this.runSearch(organizationId, employeeId, input);
  }

  private async runSearch(
    organizationId: string,
    employeeId: string,
    input: KnowledgeSearchDto
  ): Promise<{ sources: KnowledgeSource[]; metrics: KnowledgeSearchMetrics }> {
    const started = Date.now();
    if (!input.query.trim()) throw new BadRequestException("KNOWLEDGE_SEARCH_QUERY_REQUIRED");
    const topK = Math.min(
      input.topK ?? this.security.knowledge.searchDefaultTopK,
      this.security.knowledge.searchMaxTopK
    );
    const scoreThreshold =
      input.scoreThreshold ?? this.security.knowledge.searchDefaultScoreThreshold;
    const eligible = await this.prisma.knowledgeDocument.count({
      where: {
        organizationId,
        collection: { pluginInstallationId: employeeId },
        status: KnowledgeDocumentStatus.INDEXED,
        deletedAt: null,
        ...(input.collectionId ? { collectionId: input.collectionId } : {}),
        ...(input.documentIds?.length ? { id: { in: input.documentIds } } : {})
      }
    });
    if (!eligible)
      return {
        sources: [],
        metrics: {
          chunksSearched: 0,
          chunksReturned: 0,
          collectionsSearched: 0,
          topSimilarityScore: null,
          rankingDurationMs: 0,
          citationCount: 0,
          grounded: false,
          fallbackReason: "NO_ELIGIBLE_DOCUMENTS"
        }
      };
    const query = (await this.embeddings.embed(organizationId, employeeId, [input.query]))
      .vectors[0];
    if (!query) throw new BadRequestException("EMBEDDING_PROVIDER_RESPONSE_INVALID");
    const vectorLiteral = `[${query.join(",")}]`;
    const rows = await this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT c.id, c.document_id, c.chunk_index, c.content, c.page_number, c.heading,
             c.section_title, c.is_table, c.metadata, d.title AS document_title, c.collection_id,
             1 - (c.embedding <=> ${vectorLiteral}::vector) AS semantic
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.organization_id = ${organizationId}::uuid
        AND c.plugin_installation_id = ${employeeId}::uuid
        AND c.embedding IS NOT NULL
        AND d.status = 'INDEXED'
        AND d.deleted_at IS NULL
        ${input.collectionId ? Prisma.sql`AND c.collection_id = ${input.collectionId}::uuid` : Prisma.empty}
        ${input.documentIds?.length ? Prisma.sql`AND c.document_id = ANY(${input.documentIds}::uuid[])` : Prisma.empty}
      ORDER BY c.embedding <=> ${vectorLiteral}::vector
      LIMIT ${this.candidateLimit}
    `);
    // Ranking (this JS-side step only) runs against a normalized query — Hinglish filler words
    // stripped, simple spelling typos corrected (see normalizeQueryText) — while the embedding call
    // above stays on the raw `input.query`, since the embedding provider/contract is out of scope for
    // this fix. This is what lets "phle cancelation policy btao" rank the same as "cancellation policy".
    const normalizedQueryText = normalizeQueryText(input.query);
    const queryTerms = tokenize(normalizedQueryText);
    const queryGroups = groupsOf(queryTerms);
    const normalizedQuery = normalizePhrase(normalizedQueryText);
    const rankingStarted = Date.now();
    const scored = rows
      .map((row) => scoreRow(row, queryTerms, queryGroups, normalizedQuery))
      .filter((source) => source.score >= scoreThreshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
    const rankingDurationMs = Date.now() - rankingStarted;
    const debug = this.security.knowledge.retrievalDebugLogging && input.debug === true;
    if (this.security.knowledge.retrievalDebugLogging)
      this.logger.log({
        event: "KNOWLEDGE_RETRIEVAL_DEBUG",
        organizationId,
        employeeId,
        query: input.query,
        candidateCount: rows.length,
        retrievedDocuments: scored.map((source) => ({
          documentId: source.documentId,
          title: source.title
        })),
        similarityScores: scored.map((source) => Number(source.score.toFixed(4))),
        selectedChunkIds: scored.map((source) => source.chunkId),
        durationMs: Date.now() - started
      });
    return {
      sources: scored.map((source) => (debug ? source : withoutBreakdown(source))),
      metrics: {
        chunksSearched: rows.length,
        chunksReturned: scored.length,
        collectionsSearched: new Set(scored.map((source) => source.collectionId)).size,
        topSimilarityScore: scored[0] ? Number(scored[0].score.toFixed(4)) : null,
        rankingDurationMs,
        citationCount: scored.length,
        grounded: scored.length > 0,
        fallbackReason: rows.length === 0 ? "NO_CANDIDATES_RETURNED" : scored.length === 0 ? "NO_MATCHES_ABOVE_THRESHOLD" : null
      }
    };
  }
}

export interface KnowledgeSearchMetrics {
  chunksSearched: number;
  chunksReturned: number;
  collectionsSearched: number;
  topSimilarityScore: number | null;
  rankingDurationMs: number;
  citationCount: number;
  grounded: boolean;
  fallbackReason: string | null;
}

function scoreRow(
  row: CandidateRow,
  queryTerms: Set<string>,
  queryGroups: Set<number>,
  normalizedQuery: string
): KnowledgeSource {
  const semantic = Number.isFinite(row.semantic) ? row.semantic : 0;
  const keywordOverlap = overlapRatio(queryTerms, tokenize(row.content));
  const titleBoost = overlapRatio(queryTerms, tokenize(row.document_title));
  // The full heading path (this chunk's own heading plus every ancestor heading, e.g. "2.
  // Cancellation Policy" > "2.2 Standard Cancellation Windows & Refund Tiers"), not just the
  // immediate heading — a subsection under "Cancellation Policy" must inherit that ancestor's
  // relevance even though its own leaf heading doesn't repeat the word "cancellation".
  const ancestorHeadingPath = headingPath(row.metadata);
  const headingPathText = [row.heading, row.section_title, ...ancestorHeadingPath]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const metadataTerms = tokenize(headingPathText);
  const metadataBoost = overlapRatio(queryTerms, metadataTerms);
  // Only the chunk's own most-specific heading (not the shared ancestor chain) — see SCORE_WEIGHTS
  // for why this is a distinct signal from metadataBoost.
  const leafHeadingText = [row.heading, row.section_title].filter(Boolean).join(" ");
  const leafHeadingBoost = overlapRatio(queryTerms, tokenize(leafHeadingText));
  // Exact-phrase match against the query itself (never a hardcoded business vocabulary — this stays
  // employee/domain-agnostic) — a heading-path match is much stronger evidence than the same phrase
  // merely appearing somewhere in the body text of an unrelated (e.g. instructional/meta) chunk.
  const exactPhraseBoost = phraseMatches(normalizedQuery, headingPathText)
    ? 1
    : phraseMatches(normalizedQuery, row.content)
      ? 0.5
      : 0;
  // A fare/pricing query (fare, price, discount, calculation, ...) must strongly avoid a
  // cancellation-only heading ("3.6 Cancellation/Changes for Infant Bookings") even when that heading
  // also happens to mention the query's other topic (e.g. "infant") — see docs/enterprise-knowledge.md
  // "Conflicting subsection intent". Directional and narrow by design, matching the one concrete
  // conflict the UAT reported; it does not penalize a cancellation query for landing on a fare heading.
  // Also drives knowledge.prompt.ts's confidence gate (`queryConflictsWithHeading`) so a conflicted
  // chunk is never answered from even if it still happens to rank first after the penalty below.
  const conflictPenalty = hasConflictingIntent(queryGroups, headingPathText) ? 1 : 0;
  // Document Quality Filter (see "Document roles" in docs/enterprise-knowledge.md): a chunk whose own
  // heading structurally reads as an introduction/metadata/TOC/appendix/internal-note, not an actual
  // policy section, is heavily penalized here and hard-rejected by knowledge.prompt.ts's confidence
  // gate regardless of score — this is what stops an unsupported/unmatched query from ever falling back
  // to "the document introduction" just because it's the closest thing retrieval could find.
  const documentRolePenalty = classifyDocumentRole(leafHeadingText) === "SECTION" ? 0 : 1;
  const score = Math.max(
    0,
    SCORE_WEIGHTS.semantic * semantic +
      SCORE_WEIGHTS.keywordOverlap * keywordOverlap +
      SCORE_WEIGHTS.titleBoost * titleBoost +
      SCORE_WEIGHTS.metadataBoost * metadataBoost +
      SCORE_WEIGHTS.leafHeadingBoost * leafHeadingBoost +
      SCORE_WEIGHTS.exactPhraseBoost * exactPhraseBoost -
      SCORE_WEIGHTS.conflictPenalty * conflictPenalty -
      SCORE_WEIGHTS.documentRolePenalty * documentRolePenalty
  );
  return {
    chunkId: row.id,
    documentId: row.document_id,
    collectionId: row.collection_id,
    title: row.document_title,
    content: row.content,
    chunkIndex: row.chunk_index,
    pageNumber: row.page_number,
    heading: row.heading,
    sectionTitle: row.section_title,
    isTable: row.is_table,
    headingPath: ancestorHeadingPath,
    score,
    scoreBreakdown: { semantic, keywordOverlap, titleBoost, metadataBoost, exactPhraseBoost }
  };
}

/**
 * Reusable semantic term groups used purely as ranking/intent signals (never hardcoded document IDs
 * or section numbers) — see "Query-intent term groups" in docs/enterprise-knowledge.md. Two terms in
 * the same group are treated as equivalent by `termsMatch`/`overlapRatio` (e.g. "kid" and "child"),
 * and the groups a query touches (`groupsOf`) drive the conflicting-intent penalty below.
 */
const CANCELLATION_GROUP = 0;
const FARE_GROUP = 1;
const CHILD_GROUP = 2;
const AGE_GROUP = 3;
const HOTEL_GROUP = 4;
const BOOKING_GROUP = 5;
const TERM_GROUPS: readonly (readonly string[])[] = [
  ["cancel", "cancellation", "cancellations", "refund", "refunds", "refundable"],
  [
    "fare",
    "fares",
    "price",
    "prices",
    "pricing",
    "calculated",
    "calculation",
    "discount",
    "discounts",
    "charge",
    "charges",
    "cost",
    "costs",
    "percentage"
  ],
  ["infant", "infants", "baby", "babies", "kid", "kids", "child", "children"],
  ["age", "ages", "definition", "eligible", "eligibility", "consideration", "considerations"],
  ["hotel", "hotels", "accommodation", "stay"],
  ["booking", "bookings", "reservation", "reservations", "requirement", "requirements"]
];
const TERM_GROUP_INDEX = new Map<string, number>();
for (const [index, group] of TERM_GROUPS.entries())
  for (const term of group) TERM_GROUP_INDEX.set(term, index);

/** Multi-word cancellation-adjacent phrases that never survive single-token tokenization (e.g.
 * "no-show" splits into "no" + "show", neither of which is a safe standalone signal on its own). */
const CANCELLATION_PHRASES = ["no-show", "no show", "change fee"];
function headingIndicatesCancellation(headingPathText: string): boolean {
  const normalized = headingPathText.toLowerCase();
  if (CANCELLATION_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
  return groupsOf(tokenize(headingPathText)).has(CANCELLATION_GROUP);
}

function groupsOf(terms: Iterable<string>): Set<number> {
  const groups = new Set<number>();
  for (const term of terms) {
    const group = TERM_GROUP_INDEX.get(term);
    if (group !== undefined) groups.add(group);
  }
  return groups;
}

/** The single directional conflict rule (see requirement 3 in docs/enterprise-knowledge.md): a query
 * with fare/pricing intent must reject a heading that reads as cancellation-only. Shared by the ranking
 * penalty in `scoreRow` and the response-generation confidence gate (`queryConflictsWithHeading`) so a
 * conflicted chunk is penalized in ranking AND refused as an answer even if it still ends up first. */
function hasConflictingIntent(queryGroups: Set<number>, headingPathText: string): boolean {
  if (!queryGroups.has(FARE_GROUP)) return false;
  const headingGroups = groupsOf(tokenize(headingPathText));
  return !headingGroups.has(FARE_GROUP) && headingIndicatesCancellation(headingPathText);
}

/** Response-generation-facing wrapper around `hasConflictingIntent` — see knowledge.prompt.ts's
 * `isConfidentAnswer`. */
export function queryConflictsWithHeading(query: string, headingPathText: string): boolean {
  return hasConflictingIntent(queryTermGroups(query), headingPathText);
}

/**
 * Document Quality Filter (see "Document roles" in docs/enterprise-knowledge.md): a structural
 * classification of what KIND of content a chunk is, derived purely from generic document-genre
 * vocabulary in its own heading text — never a specific business/policy name, so this generalizes to
 * every future AI Employee's documents without modification. SECTION is the only role that may ever
 * become a final answer; everything else (an introduction, a metadata/version block, a table of
 * contents, an appendix/glossary, or an internal/AI-facing implementation note) is real document
 * content that was never meant to answer a user's question on its own.
 */
export type DocumentRole =
  | "INTRODUCTION"
  | "METADATA"
  | "TABLE_OF_CONTENTS"
  | "APPENDIX"
  | "INTERNAL_NOTE"
  | "SECTION";

const DOCUMENT_ROLE_PATTERNS: readonly (readonly [RegExp, DocumentRole])[] = [
  [/\btable\s+of\s+contents\b|\bcontents\b/i, "TABLE_OF_CONTENTS"],
  [
    /\binternal\s+note\b|\bnote\s+for\s+(?:ai|implementation)\b|\bimplementation\s+note\b|\bai\s+(?:agent\s+)?instructions?\b|\bhow\s+to\s+use\s+this\s+document\b/i,
    "INTERNAL_NOTE"
  ],
  [
    /\bversion\s+history\b|\brevision\s+history\b|\bdocument\s+(?:metadata|control|information)\b|\blast\s+updated\b|\bchange\s*log\b/i,
    "METADATA"
  ],
  [/\bappendix\b|\bannex(?:ure)?\b|\bglossary\b/i, "APPENDIX"],
  [
    /\bintroduction\b|\boverview\b|\babout\s+this\s+document\b|\bpurpose(?:\s+and\s+scope)?\b|\bpreface\b|\bforeword\b/i,
    "INTRODUCTION"
  ]
];

/** Classifies a chunk's document role from its own heading text (the leaf heading, not the full
 * ancestor path — an "Appendix" *section* containing real "Cancellation Policy" content nested under it
 * should not itself be excluded just because an ancestor happens to say "Appendix"). */
export function classifyDocumentRole(headingText: string): DocumentRole {
  for (const [pattern, role] of DOCUMENT_ROLE_PATTERNS) if (pattern.test(headingText)) return role;
  return "SECTION";
}

/** True for any role other than SECTION — used by knowledge.prompt.ts's confidence gate to hard-reject
 * a document-introduction/metadata/TOC/appendix/internal-note chunk from ever becoming a final answer,
 * regardless of how high its score otherwise is. */
export function isNonPolicyDocumentRole(headingText: string): boolean {
  return classifyDocumentRole(headingText) !== "SECTION";
}

/** Hinglish filler words that carry no topical signal in a code-mixed query ("phle cancelation policy
 * btao" = "tell me the cancellation policy first") — dropped the same way English STOPWORDS are, so
 * they don't dilute overlapRatio's denominator. Deliberately a small, bounded list, not a translator. */
const HINGLISH_STOPWORDS = new Set([
  "phle",
  "pehle",
  "btao",
  "bata",
  "batao",
  "bataiye",
  "karo",
  "kro",
  "karna",
  "krna",
  "jana",
  "jaana",
  "hai",
  "hain",
  "ka",
  "ki",
  "ke",
  "se",
  "mujhe",
  "muje",
  "chahiye",
  "kya",
  "kaise"
]);

/** Deterministic, dictionary-free spelling correction: only fixes a query word against this file's own
 * curated vocabulary (TERM_GROUPS) when it is a single edit away (see `levenshteinAtMost1`) — e.g.
 * "cancelation" -> "cancellation". Restricted to words of 6+ characters on both sides to avoid
 * misfiring on short, unrelated words. No translation service or LLM call; see "Normalize the query
 * before ranking" in docs/enterprise-knowledge.md. */
const NORMALIZATION_VOCABULARY = [...TERM_GROUP_INDEX.keys()].filter((term) => term.length >= 6);
function correctSpelling(word: string): string {
  if (word.length < 6 || TERM_GROUP_INDEX.has(word)) return word;
  for (const candidate of NORMALIZATION_VOCABULARY) {
    if (Math.abs(candidate.length - word.length) > 1) continue;
    if (levenshteinAtMost1(word, candidate)) return candidate;
  }
  return word;
}
function levenshteinAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0,
    j = 0,
    edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (shorter.length === longer.length) {
      i++;
      j++;
    } else {
      j++;
    }
  }
  return true;
}

/** Query normalization applied before ranking (not before embedding — see `search()`): lowercases,
 * drops Hinglish filler words, and corrects simple spelling typos against this file's own vocabulary.
 * Exported so knowledge.prompt.ts's broad-topic/intent detection sees the same normalized text. */
export function normalizeQueryText(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => !HINGLISH_STOPWORDS.has(word))
    .map((word) => correctSpelling(word))
    .join(" ");
}

/** "booking" immediately after a preposition ("benefits **of booking** through your portal", "**when
 * booking**...", "**before booking**...") names the ACT of booking — a gerund/verbal-noun — not the
 * booking/reservation-requirements topic `TERM_GROUPS[BOOKING_GROUP]` actually curates ("booking
 * requirements", "group booking policy"). Left in, a generic sentence that merely mentions the word
 * "booking" in passing wrongly demands the candidate heading also cover that topic
 * (`headingPathMatchesQueryIntent`'s "every wanted group" rule) — e.g. "Portal Benefits" is an exact
 * topical match for "what are the benefits of booking through your portal" but doesn't itself mention
 * booking/reservation, so it was being rejected. "bookings" (plural) is never used this way in practice
 * and is unaffected, as are "reservation(s)"/"requirement(s)". */
const BOOKING_GERUND_PATTERN = /\b(?:of|when|while|before|after|by|via)\s+booking\b/g;

/** The TERM_GROUPS a (normalized) query touches — e.g. "how kids fare is calculated" -> the
 * infant/child group and the fare/pricing group. Exported for knowledge.prompt.ts's confidence gating,
 * which needs to know whether the top result's own heading path actually shares a topic with the
 * query ("intent alignment") — see `headingPathMatchesQueryIntent`. */
export function queryTermGroups(query: string): Set<number> {
  const normalized = normalizeQueryText(query).replace(BOOKING_GERUND_PATTERN, (match) =>
    match.replace(/booking$/, "")
  );
  return groupsOf(tokenize(normalized));
}

/** True when the query has no strong topical group of its own (nothing to misalign with) or when the
 * candidate heading path covers *every* term group the query touches. Deliberately "all of", not "any
 * of": a query naming two groups (e.g. "infant and kids discount" -> infant/child + fare/pricing) must
 * not be satisfied by a heading that only matches the easy/incidental one (every subsection in an
 * infant section mentions "infant") while missing the group that actually makes the query specific
 * (fare/pricing) — that gap is exactly how "3.6 Cancellation/Changes for Infant Bookings" used to win
 * on "infant" alone despite having nothing to do with fares. */
export function headingPathMatchesQueryIntent(query: string, headingPathText: string): boolean {
  const wanted = queryTermGroups(query);
  if (!wanted.size) return true;
  const present = groupsOf(tokenize(headingPathText));
  for (const group of wanted) if (!present.has(group)) return false;
  return true;
}

/** Narrowing attributes that turn a bare infant/child query into a specific one (see requirement 3 in
 * docs/enterprise-knowledge.md): fare, age/eligibility, cancellation, hotel, or booking. */
const CHILD_NARROWING_GROUPS: readonly number[] = [
  FARE_GROUP,
  AGE_GROUP,
  CANCELLATION_GROUP,
  HOTEL_GROUP,
  BOOKING_GROUP
];

/**
 * True for a query that names the infant/child topic (kid, kids, child, children, infant, infants, baby,
 * babies) with no narrower attribute alongside it — "where is kids policy", "infants", "tell me about
 * children" — and therefore warrants a broad section summary rather than whichever single subsection
 * happens to score highest. False the moment a narrowing attribute is present ("infant fare", "infant
 * age", "infant cancellation"), which must still resolve to one specific subsection.
 */
export function isBroadInfantChildQuery(query: string): boolean {
  const groups = queryTermGroups(query);
  if (!groups.has(CHILD_GROUP)) return false;
  return !CHILD_NARROWING_GROUPS.some((group) => groups.has(group));
}

// "what is", "can i", "where is", "tell me about", "explain", "how do/can i" — a question shape that,
// combined with no travel signal (checked first by the caller — see AgentService's request routing), is
// itself evidence of an informational/policy ask rather than an action request.
const POLICY_QUESTION_SHAPE = /\b(?:what\s+is|what\s+are|can\s+i|where\s+is|tell\s+me\s+about|explain|how\s+(?:do|can)\s+i)\b/i;

/**
 * A message-only (no retrieval, no score — see "Request routing" in docs/enterprise-knowledge.md)
 * signal that the current turn reads like a knowledge/policy question: it names "policy"/"rules", touches
 * one of the curated term groups (cancellation, fare, infant/child, age, hotel, booking), or has an
 * explicit question shape ("what is", "can I", "tell me about"). Used by AgentService to decide whether
 * the central knowledge-grounded-answer bypass may run at all for this turn — retrieval results and
 * scores are never part of that decision, only the text of the message itself.
 */
export function looksLikeKnowledgeQuery(query: string): boolean {
  if (/\b(?:polic(?:y|ies)|rules?)\b/i.test(query)) return true;
  if (queryTermGroups(query).size > 0) return true;
  return POLICY_QUESTION_SHAPE.test(query);
}

function headingPath(metadata: unknown): string[] {
  if (typeof metadata !== "object" || metadata === null) return [];
  const value = (metadata as Record<string, unknown>).headingPath;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
/** Normalizes to lowercase with collapsed whitespace so phrase matching ignores case/spacing only —
 * never a fuzzy/synonym match, this is a literal substring check. */
function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
function phraseMatches(normalizedQuery: string, candidate: string): boolean {
  return normalizedQuery.length > 2 && normalizePhrase(candidate).includes(normalizedQuery);
}

function withoutBreakdown(source: KnowledgeSource): KnowledgeSource {
  return {
    chunkId: source.chunkId,
    documentId: source.documentId,
    collectionId: source.collectionId,
    title: source.title,
    content: source.content,
    chunkIndex: source.chunkIndex,
    pageNumber: source.pageNumber,
    heading: source.heading,
    sectionTitle: source.sectionTitle,
    isTable: source.isTable,
    headingPath: source.headingPath,
    score: source.score
  };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "your",
  "you",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "do",
  "does",
  "did",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "and",
  "or",
  "it",
  "this",
  "that",
  "with",
  "as",
  "be",
  "by",
  "we",
  "our",
  "i",
  "my"
]);
function tokenize(value: string): Set<string> {
  const terms = (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (term) => term.length > 1 && !STOPWORDS.has(term)
  );
  return new Set(terms);
}
/** A shared 4+ character prefix counts as a match (e.g. "cancel" ~ "cancellation", "refund" ~
 * "refundable"/"non-refundable") — a lightweight, vocabulary-agnostic stand-in for stemming so a
 * natural-language query ("Can I cancel my booking?") still matches a heading/content that only
 * contains the noun form ("Cancellation Policy"), without hardcoding any business term list. Two terms
 * in the same curated TERM_GROUPS group (e.g. "kid" ~ "child", too short for prefix matching) also
 * count as a match, and a 6+ character term within one edit of another is treated as the same typo. */
function termsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const groupA = TERM_GROUP_INDEX.get(a);
  if (groupA !== undefined && groupA === TERM_GROUP_INDEX.get(b)) return true;
  const minLength = 4;
  if ((a.length >= minLength && b.startsWith(a)) || (b.length >= minLength && a.startsWith(b)))
    return true;
  return a.length >= 6 && b.length >= 6 && levenshteinAtMost1(a, b);
}
function overlapRatio(query: Set<string>, target: Set<string>): number {
  if (!query.size) return 0;
  let hits = 0;
  for (const term of query) {
    for (const candidate of target) {
      if (termsMatch(term, candidate)) {
        hits++;
        break;
      }
    }
  }
  return hits / query.size;
}
