/**
 * Sprint 6.1B Feature 9 — a small, dependency-free fuzzy scorer for the marketplace search endpoint.
 * Combines exact-substring matches (highest weight) with token overlap and a bounded Levenshtein
 * distance (typo tolerance for short queries) — no external fuzzy-search library needed for a
 * per-organization catalog of a few dozen skills/packs/templates.
 */
export function fuzzyScore(query: string, haystacks: string[]): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let score = 0;
  for (const raw of haystacks) {
    const haystack = raw.toLowerCase();
    if (haystack === needle) {
      score += 100;
      continue;
    }
    if (haystack.includes(needle)) {
      score += 50;
      continue;
    }
    const needleTokens = needle.split(/\s+/).filter(Boolean);
    const haystackTokens = new Set(haystack.split(/\s+/).filter(Boolean));
    const overlap = needleTokens.filter((token) => haystackTokens.has(token)).length;
    if (overlap > 0) {
      score += overlap * 15;
      continue;
    }
    if (needle.length <= 24) {
      const distance = boundedLevenshtein(needle, haystack, 3);
      if (distance <= 2) score += Math.max(0, 20 - distance * 8);
    }
  }
  return score;
}

/** Levenshtein distance between `a` and the best-matching substring window of `b`, capped at `max`
 *  for performance — returns `max + 1` once exceeded rather than computing the full matrix. */
function boundedLevenshtein(a: string, b: string, max: number): number {
  const windowSize = a.length + max;
  let best = max + 1;
  for (let start = 0; start <= Math.max(0, b.length - 1); start += 1) {
    const window = b.slice(start, start + windowSize);
    const distance = levenshtein(a, window);
    if (distance < best) best = distance;
    if (best === 0) break;
  }
  return best;
}

/** Space-optimized Levenshtein distance (two rolling rows) — avoids 2D-array indexing entirely, so
 *  there's never a `T | undefined` cell to force-unwrap. */
function levenshtein(a: string, b: string): number {
  let previousRow: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const deletionCost = (previousRow[j] ?? 0) + 1;
      const insertionCost = (currentRow[j - 1] ?? 0) + 1;
      const substitutionCost = (previousRow[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      currentRow.push(Math.min(deletionCost, insertionCost, substitutionCost));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length] ?? Math.max(a.length, b.length);
}
