import { cosineSimilarity } from "#public/memory/learning/embedding.js";
import type { MemoryRecord } from "#public/memory/learning/record.js";
import { termFrequencies, tokenize, tokenizeCached } from "#public/memory/learning/text.js";

/** What a retrieval strategy is asked to find. */
export interface RetrievalQuery {
  readonly now: number;
  readonly terms: readonly string[];
  readonly text: string;
  readonly vector?: readonly number[];
}

export interface RankedRecord {
  readonly record: MemoryRecord;
  readonly score: number;
}

/**
 * A ranking strategy over the whole store.
 *
 * Retrieval is separated from the architecture that wrote a record so the two
 * can be varied independently: the same episodic history can be ranked
 * lexically, semantically, or by recency without rewriting storage.
 */
export interface MemoryRetrieval {
  readonly name: string;
  /** Whether the strategy needs the query embedded before it can rank. */
  readonly needsVector: boolean;
  rank(
    query: RetrievalQuery,
    records: readonly MemoryRecord[],
    limit: number,
  ): readonly RankedRecord[];
}

export function buildQuery(text: string, now: number, vector?: readonly number[]): RetrievalQuery {
  const query: { now: number; terms: readonly string[]; text: string; vector?: readonly number[] } =
    { now, terms: tokenize(text), text };
  if (vector !== undefined) query.vector = vector;
  return query;
}

// ---------------------------------------------------------------------------
// Lexical
// ---------------------------------------------------------------------------

export interface Bm25Options {
  /** Term-frequency saturation. Higher rewards repeated terms more. */
  readonly k1?: number;
  /** Length normalization, 0–1. */
  readonly b?: number;
}

/**
 * Okapi BM25 over the record texts. Exact and near-exact term overlap is what
 * an agent's memory is usually keyed on — an error message, a package name, a
 * person — and BM25 handles those far better than an embedding of the same
 * size.
 */
export function bm25(options: Bm25Options = {}): MemoryRetrieval {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;

  return {
    name: "bm25",
    needsVector: false,
    rank(query, records, limit) {
      if (query.terms.length === 0 || records.length === 0) return [];
      const documents = records.map((record) => termFrequencies(tokenizeCached(record.text)));
      const lengths = documents.map((document) => sum(document.values()));
      const averageLength =
        lengths.reduce((total, value) => total + value, 0) / lengths.length || 1;

      const documentFrequency = new Map<string, number>();
      for (const term of new Set(query.terms)) {
        documentFrequency.set(
          term,
          documents.reduce((count, document) => count + (document.has(term) ? 1 : 0), 0),
        );
      }

      const scored: RankedRecord[] = [];
      for (const [index, record] of records.entries()) {
        let score = 0;
        for (const [term, queryCount] of termFrequencies(query.terms)) {
          const frequency = documents[index]!.get(term) ?? 0;
          if (frequency === 0) continue;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (records.length - df + 0.5) / (df + 0.5));
          const denominator = frequency + k1 * (1 - b + (b * lengths[index]!) / averageLength);
          score += queryCount * idf * ((frequency * (k1 + 1)) / denominator);
        }
        if (score > 0) scored.push({ record, score });
      }
      return take(normalizeScores(scored), limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Semantic
// ---------------------------------------------------------------------------

/** Cosine similarity against each record's stored vector. */
export function vectorSimilarity(options: { readonly floor?: number } = {}): MemoryRetrieval {
  const floor = options.floor ?? 0.05;

  return {
    name: "vector",
    needsVector: true,
    rank(query, records, limit) {
      if (query.vector === undefined) return [];
      const scored: RankedRecord[] = [];
      for (const record of records) {
        if (record.vector === undefined) continue;
        const score = cosineSimilarity(query.vector, record.vector);
        if (score > floor) scored.push({ record, score });
      }
      return take(scored.toSorted(byScore), limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------

export interface HybridOptions {
  /**
   * `rrf` fuses by rank, which needs no score calibration between strategies.
   * `weighted` fuses normalized scores, which preserves margin.
   */
  readonly method?: "rrf" | "weighted";
  /** Reciprocal-rank-fusion constant. Larger flattens the contribution of top ranks. */
  readonly rrfK?: number;
  /** Per-strategy weights for `weighted`, in the order the strategies are given. */
  readonly weights?: readonly number[];
}

/** Combines several strategies into one ranking. */
export function hybrid(
  retrievals: readonly MemoryRetrieval[],
  options: HybridOptions = {},
): MemoryRetrieval {
  if (retrievals.length === 0) throw new TypeError("hybrid() requires at least one strategy.");
  const method = options.method ?? "rrf";
  const rrfK = options.rrfK ?? 60;
  const weights = options.weights ?? retrievals.map(() => 1);
  if (weights.length !== retrievals.length) {
    throw new TypeError("hybrid() weights must have one entry per strategy.");
  }

  return {
    name: `hybrid(${retrievals.map((retrieval) => retrieval.name).join("+")},${method}${
      method === "weighted" ? `[${weights.join(",")}]` : ""
    })`,
    needsVector: retrievals.some((retrieval) => retrieval.needsVector),
    rank(query, records, limit) {
      const fused = new Map<string, { record: MemoryRecord; score: number }>();
      // Fusion needs each strategy's full opinion, not just its top slice.
      const depth = Math.max(limit * 4, 32);
      for (const [index, retrieval] of retrievals.entries()) {
        const ranked = retrieval.rank(query, records, depth);
        for (const [position, entry] of ranked.entries()) {
          const contribution =
            method === "rrf"
              ? weights[index]! / (rrfK + position + 1)
              : weights[index]! * entry.score;
          const existing = fused.get(entry.record.id);
          if (existing === undefined) {
            fused.set(entry.record.id, { record: entry.record, score: contribution });
          } else {
            existing.score += contribution;
          }
        }
      }
      return take(normalizeScores([...fused.values()]), limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Salience
// ---------------------------------------------------------------------------

export interface SalienceOptions {
  /** Half-life of the recency term. Defaults to seven days. */
  readonly halfLifeMs?: number;
  readonly importanceWeight?: number;
  readonly recencyWeight?: number;
  readonly relevanceWeight?: number;
}

/**
 * Blends a strategy's relevance with recency and importance.
 *
 * A memory an agent formed an hour ago about the task at hand usually beats a
 * slightly better lexical match from three months ago, and the store carries
 * both. The weights come from the generative-agent retrieval formula, tuned
 * here against the recall benchmark.
 */
export function salienceWeighted(
  inner: MemoryRetrieval,
  options: SalienceOptions = {},
): MemoryRetrieval {
  const halfLifeMs = options.halfLifeMs ?? 7 * 24 * 60 * 60 * 1_000;
  const relevanceWeight = options.relevanceWeight ?? 1;
  const recencyWeight = options.recencyWeight ?? 0.35;
  const importanceWeight = options.importanceWeight ?? 0.25;

  return {
    name: `salience(${inner.name})`,
    needsVector: inner.needsVector,
    rank(query, records, limit) {
      const ranked = inner.rank(query, records, Math.max(limit * 4, 32));
      const scored = ranked.map((entry) => {
        const ageMs = Math.max(0, query.now - entry.record.updatedAt);
        const recency = Math.pow(0.5, ageMs / halfLifeMs);
        const salience = entry.record.importance * entry.record.confidence;
        return {
          record: entry.record,
          score:
            relevanceWeight * entry.score + recencyWeight * recency + importanceWeight * salience,
        };
      });
      return take(scored.toSorted(byScore), limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/**
 * Maximal marginal relevance. Recall is capped by a character budget, so
 * three phrasings of one fact cost two slots that a different fact could
 * have used.
 */
export function diversified(
  inner: MemoryRetrieval,
  options: { readonly lambda?: number } = {},
): MemoryRetrieval {
  const lambda = options.lambda ?? 0.75;
  if (lambda <= 0 || lambda > 1) {
    throw new TypeError("diversified() lambda must be greater than 0 and at most 1.");
  }

  return {
    name: `diversified(${inner.name},\u03bb=${lambda})`,
    needsVector: inner.needsVector,
    rank(query, records, limit) {
      const candidates = [...inner.rank(query, records, Math.max(limit * 3, 24))];
      const selected: RankedRecord[] = [];
      while (selected.length < limit && candidates.length > 0) {
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const [index, candidate] of candidates.entries()) {
          const redundancy = selected.reduce(
            (worst, chosen) => Math.max(worst, similarity(candidate.record, chosen.record)),
            0,
          );
          const score = lambda * candidate.score - (1 - lambda) * redundancy;
          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }
        selected.push(candidates.splice(bestIndex, 1)[0]!);
      }
      return selected;
    },
  };
}

function similarity(left: MemoryRecord, right: MemoryRecord): number {
  if (left.vector !== undefined && right.vector !== undefined) {
    return cosineSimilarity(left.vector, right.vector);
  }
  const leftTerms = new Set(tokenizeCached(left.text));
  const rightTerms = new Set(tokenizeCached(right.text));
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared / (leftTerms.size + rightTerms.size - shared);
}

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

/**
 * The composition the recall benchmark selects: lexical and semantic scores
 * fused by reciprocal rank, blended with recency and importance, then
 * de-duplicated by marginal relevance.
 *
 * See `research/learning-memory.md` for the measured comparison against each
 * strategy on its own.
 */
export function balancedRetrieval(): MemoryRetrieval {
  return diversified(
    salienceWeighted(hybrid([bm25(), vectorSimilarity()], { method: "weighted", weights: [1, 1] })),
    { lambda: 0.7 },
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function byScore(left: RankedRecord, right: RankedRecord): number {
  if (right.score !== left.score) return right.score - left.score;
  return right.record.updatedAt - left.record.updatedAt;
}

function normalizeScores(scored: readonly RankedRecord[]): readonly RankedRecord[] {
  if (scored.length === 0) return scored;
  const highest = Math.max(...scored.map((entry) => entry.score));
  if (highest <= 0) return scored.toSorted(byScore);
  return scored.map((entry) => ({ ...entry, score: entry.score / highest })).toSorted(byScore);
}

function take(scored: readonly RankedRecord[], limit: number): readonly RankedRecord[] {
  return scored.slice(0, Math.max(0, limit));
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
