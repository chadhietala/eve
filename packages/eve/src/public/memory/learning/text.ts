/**
 * Text primitives shared by the retrieval strategies.
 *
 * Everything here is deterministic and dependency-free so that recall
 * behaves identically in a unit test, an eval, and production, and so a
 * learning agent never needs a network round trip to remember something.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "over",
  "she",
  "should",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "too",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const SUFFIXES = ["ingly", "edly", "ing", "ies", "ied", "ers", "er", "ed", "es", "s"] as const;

/**
 * Splits text into comparable terms: lowercased, punctuation-free, stop-worded,
 * and suffix-stripped so `deploying` and `deployed` match `deploy`.
 */
export function tokenize(text: string): readonly string[] {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_+#.-]+/)) {
    const token = raw.replace(/^[.\-+#]+|[.\-+#]+$/g, "");
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    terms.push(stem(token));
  }
  return terms;
}

/** Truncating suffix stripper. Not linguistically correct; consistently applied. */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

/** Character n-grams, used so a vector still matches across typos and inflection. */
export function characterNgrams(text: string, size = 3): readonly string[] {
  const normalized = ` ${text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim()} `;
  if (normalized.length <= size) return [normalized];
  const grams: string[] = [];
  for (let index = 0; index + size <= normalized.length; index += 1) {
    grams.push(normalized.slice(index, index + size));
  }
  return grams;
}

/** FNV-1a. Small, fast, and stable across processes and platforms. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function termFrequencies(terms: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return counts;
}

const TOKEN_CACHE_LIMIT = 4_096;
const tokenCache = new Map<string, readonly string[]>();

/**
 * Memoized {@link tokenize}. Ranking re-reads every record on every turn, so
 * the same texts are tokenized repeatedly within one process.
 */
export function tokenizeCached(text: string): readonly string[] {
  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;
  const terms = tokenize(text);
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    // Cheapest useful eviction: drop the oldest insertion.
    const oldest = tokenCache.keys().next();
    if (!oldest.done) tokenCache.delete(oldest.value);
  }
  tokenCache.set(text, terms);
  return terms;
}
