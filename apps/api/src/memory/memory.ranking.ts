import {
  MEMORY_IMPORTANCE_WEIGHT,
  MEMORY_RANKING_WEIGHTS,
  type MemoryRecordValue,
  type MemorySearchHit
} from "./memory.types";

/**
 * Sprint 4.5: memory ranking (exact + semantic + importance + recentness + confidence).
 *
 * `scoreMemory` combines four normalized signals into a single [0,1] retrieval score:
 *   score = semantic*0.45 + keyword*0.35 + recency*0.1 + importance*0.1   (then * confidence)
 *
 * - semantic  : cosine similarity from the pgvector embedding, 0 when the record has no embedding.
 * - keyword   : overlap ratio between the query terms and (key + category + searchableText). An exact
 *               key match scores 1 so "my airline preference" reliably finds `preferred.airline`.
 * - recency   : exp(-daysSinceUpdate / halfLife) — preferences never expire, but freshly-updated
 *               facts (e.g. "my hotel today") outrank stale ones.
 * - importance: CRITICAL > HIGH > MEDIUM > LOW.
 * - confidence: multiplied across the whole score, so a low-confidence extraction can never outrank a
 *               high-confidence one for the same query.
 */

const TERM_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenize(value: string): string[] {
  return (value?.toLowerCase().match(TERM_PATTERN) ?? []);
}

function overlapRatio(queryTerms: string[], haystack: string[]): number {
  if (!queryTerms.length || !haystack.length) return 0;
  const unique = new Set(queryTerms);
  const corpus = new Set(haystack);
  let hits = 0;
  for (const term of unique) if (corpus.has(term)) hits += 1;
  return hits / unique.size;
}

/** Recency in [0,1] — decays toward 0 as the memory ages past the half-life. */
export function recencyScore(updatedAt: Date, now: Date = new Date()): number {
  const ageDays = Math.max(0, (now.getTime() - updatedAt.getTime()) / (24 * 60 * 60 * 1000));
  return Math.exp(-ageDays / MEMORY_RANKING_WEIGHTS.recencyHalfLifeDays);
}

/**
 * Ranks a single memory record against a query. `semanticScore` is optional — pass the pgvector
 * cosine similarity (0..1) when available; 0 is used when the record has no embedding.
 */
export function scoreMemory(
  query: string,
  record: Pick<
    MemoryRecordValue,
    | "key"
    | "category"
    | "searchableText"
    | "value"
    | "importance"
    | "confidence"
    | "updatedAt"
  >,
  semanticScore = 0
): { score: number; semanticScore: number; keywordScore: number } {
  const queryTerms = tokenize(query);
  const haystack = tokenize(
    [record.key, record.category, record.searchableText, JSON.stringify(record.value)].join(" ")
  );
  const normalizedQuery = query.trim().toLowerCase();
  const keyLower = record.key.toLowerCase();
  // Exact key match is the strongest possible signal.
  const keywordScore =
    normalizedQuery.length > 0 && (keyLower === normalizedQuery || keyLower.includes(normalizedQuery))
      ? 1
      : overlapRatio(queryTerms, haystack);
  const recency = recencyScore(record.updatedAt);
  const importance = MEMORY_IMPORTANCE_WEIGHT[record.importance] ?? 0;
  const semantic = Number.isFinite(semanticScore) && semanticScore > 0 ? Math.max(0, semanticScore) : 0;
  const confidence = Number.isFinite(record.confidence)
    ? Math.min(1, Math.max(0, record.confidence))
    : 1;
  const raw =
    semantic * MEMORY_RANKING_WEIGHTS.semantic +
    keywordScore * MEMORY_RANKING_WEIGHTS.keyword +
    recency * MEMORY_RANKING_WEIGHTS.recency +
    importance * MEMORY_RANKING_WEIGHTS.importance;
  return {
    score: raw * confidence,
    semanticScore: semantic,
    keywordScore
  };
}

/**
 * Ranks a list of records against `query`, attaching scores and sorting descending. Optionally accepts
 * a map of recordId -> semantic score (from a vector search pass). Exposes `rank` for the platform API.
 */
export function rankMemories(
  query: string,
  records: MemoryRecordValue[],
  semanticScores: Map<string, number> = new Map()
): MemorySearchHit[] {
  return records
    .map((record) => {
      const scored = scoreMemory(query, record, semanticScores.get(record.id) ?? 0);
      return { ...record, ...scored };
    })
    .sort((left, right) => right.score - left.score);
}
