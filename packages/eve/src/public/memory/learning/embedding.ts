import { characterNgrams, hashString, tokenize } from "#public/memory/learning/text.js";

/** Turns text into a unit-length vector for similarity search. */
export interface MemoryEmbedding {
  /** Stable identifier stored with each record so stale vectors are detected. */
  readonly id: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface HashingEmbeddingOptions {
  readonly dimensions?: number;
  /** Weight of character-trigram features relative to whole terms. */
  readonly ngramWeight?: number;
}

/**
 * A deterministic embedding built from feature hashing (random indexing):
 * every term and character trigram is hashed to a dimension and a sign, and
 * the accumulated vector is L2-normalized.
 *
 * It needs no model, no network, and no warm-up, which is what makes it a
 * usable default — recall must work on the first turn of a fresh deployment.
 * Pass a model-backed embedding when true paraphrase matching matters.
 */
export function hashingEmbedding(options: HashingEmbeddingOptions = {}): MemoryEmbedding {
  const dimensions = options.dimensions ?? 96;
  if (!Number.isInteger(dimensions) || dimensions < 8 || dimensions > 4_096) {
    throw new TypeError("hashingEmbedding() dimensions must be an integer between 8 and 4096.");
  }
  const ngramWeight = options.ngramWeight ?? 0.5;

  return {
    dimensions,
    id: `hashing-v1:${dimensions}:${ngramWeight}`,
    async embed(texts) {
      return texts.map((text) => {
        const vector = Array.from<number>({ length: dimensions }).fill(0);
        for (const term of tokenize(text)) add(vector, term, 1);
        for (const gram of characterNgrams(text)) add(vector, gram, ngramWeight);
        return normalize(vector);
      });
    },
  };

  function add(vector: number[], feature: string, weight: number): void {
    const hash = hashString(feature);
    const index = hash % dimensions;
    const sign = (hash >>> 31) & 1 ? -1 : 1;
    vector[index] = vector[index]! + sign * weight;
  }
}

export function normalize(vector: readonly number[]): readonly number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;
  const length = Math.sqrt(sum);
  return vector.map((value) => value / length);
}

/** Cosine similarity of two unit-length vectors, clamped to [0, 1]. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return Math.max(0, Math.min(1, dot));
}
