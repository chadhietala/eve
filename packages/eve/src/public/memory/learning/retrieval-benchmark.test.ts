import { describe, expect, it } from "vitest";

import { hashingEmbedding } from "#public/memory/learning/embedding.js";
import type { MemoryRecord } from "#public/memory/learning/record.js";
import {
  balancedRetrieval,
  bm25,
  buildQuery,
  diversified,
  hybrid,
  salienceWeighted,
  vectorSimilarity,
  type MemoryRetrieval,
} from "#public/memory/learning/retrieval.js";

/**
 * Recall benchmark for the retrieval strategies.
 *
 * The corpus is generated from a fixed seed, so the numbers below are
 * reproducible and a regression in ranking shows up as a failing assertion
 * rather than a slow drift in behavior. `research/learning-memory.md` records
 * the measured comparison this produces.
 */

const NOW = Date.UTC(2026, 8, 1);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const TOP_K = 8;

interface Case {
  readonly family: "exact" | "paraphrase" | "recency" | "redundancy";
  readonly gold: readonly string[];
  readonly query: string;
}

interface Dataset {
  readonly cases: readonly Case[];
  readonly records: readonly MemoryRecord[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SUBJECTS = [
  "deployment",
  "invoice",
  "changelog",
  "dashboard",
  "webhook",
  "migration",
  "onboarding",
  "billing",
  "incident",
  "release",
  "backup",
  "index",
];
const OBJECTS = [
  "postgres",
  "vercel",
  "stripe",
  "linear",
  "slack",
  "github",
  "redis",
  "cloudflare",
  "datadog",
  "supabase",
  "clerk",
  "resend",
];
const VERBS = ["rotate", "retry", "publish", "reconcile", "throttle", "annotate"];

function buildDataset(): Dataset {
  const random = mulberry32(20_260_905);
  const records: MemoryRecord[] = [];
  const cases: Case[] = [];
  let sequence = 0;

  const push = (input: {
    readonly ageMs: number;
    readonly importance?: number;
    readonly kind?: MemoryRecord["kind"];
    readonly text: string;
  }): string => {
    const id = `r${(sequence += 1).toString().padStart(4, "0")}`;
    const createdAt = NOW - input.ageMs;
    records.push({
      accessCount: 0,
      confidence: 0.8,
      createdAt,
      id,
      importance: input.importance ?? 0.5,
      kind: input.kind ?? "fact",
      lastAccessedAt: createdAt,
      text: input.text,
      updatedAt: createdAt,
    });
    return id;
  };

  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

  // Family 1 — exact terms. A distinctive phrase appears verbatim in one record.
  for (let index = 0; index < 12; index += 1) {
    const subject = SUBJECTS[index % SUBJECTS.length]!;
    const object = OBJECTS[(index * 5) % OBJECTS.length]!;
    const verb = pick(VERBS);
    const gold = push({
      ageMs: (10 + index) * DAY,
      importance: 0.6,
      text: `The ${subject} for ${object} must ${verb} before the nightly window closes.`,
    });
    for (let noise = 0; noise < 3; noise += 1) {
      push({
        ageMs: (2 + noise) * DAY,
        text: `The ${pick(SUBJECTS)} step uses ${object} for reporting only.`,
      });
    }
    cases.push({ family: "exact", gold: [gold], query: `${subject} ${object} ${verb}` });
  }

  // Family 2 — inflection and typos. The query never matches a term verbatim.
  for (let index = 0; index < 12; index += 1) {
    const subject = SUBJECTS[(index * 3) % SUBJECTS.length]!;
    const object = OBJECTS[(index * 7) % OBJECTS.length]!;
    const gold = push({
      ageMs: (20 + index) * DAY,
      importance: 0.6,
      text: `Always publish the ${subject} notes to ${object} after a successful build.`,
    });
    for (let noise = 0; noise < 3; noise += 1) {
      push({ ageMs: (5 + noise) * DAY, text: `Unrelated note about ${pick(SUBJECTS)} planning.` });
    }
    cases.push({
      family: "paraphrase",
      gold: [gold],
      query: `publishing ${subject}s notes ${typo(object, random)}`,
    });
  }

  // Family 3 — recency. Two records state the same thing; only the fresh one holds.
  for (let index = 0; index < 12; index += 1) {
    const subject = SUBJECTS[(index * 2) % SUBJECTS.length]!;
    const object = OBJECTS[(index * 11) % OBJECTS.length]!;
    push({
      ageMs: 120 * DAY,
      importance: 0.4,
      text: `The ${subject} owner for ${object} is the platform team.`,
    });
    const gold = push({
      ageMs: 2 * HOUR,
      importance: 0.8,
      text: `The ${subject} owner for ${object} is now the growth team.`,
    });
    for (let noise = 0; noise < 2; noise += 1) {
      push({ ageMs: (30 + noise) * DAY, text: `The ${subject} runbook lives in the wiki.` });
    }
    cases.push({ family: "recency", gold: [gold], query: `who owns ${subject} for ${object}` });
  }

  // Family 4 — redundancy. Nine restatements crowd out a second relevant facet.
  for (let index = 0; index < 12; index += 1) {
    const subject = SUBJECTS[(index * 5) % SUBJECTS.length]!;
    const object = OBJECTS[(index * 3) % OBJECTS.length]!;
    const duplicates: string[] = [];
    for (let copy = 0; copy < 9; copy += 1) {
      duplicates.push(
        push({
          ageMs: (3 + copy) * DAY,
          importance: 0.5,
          text: `The ${subject} pipeline for ${object} runs on a nightly schedule${
            copy === 0 ? "." : ` (noted again on day ${copy}).`
          }`,
        }),
      );
    }
    const facet = push({
      ageMs: 6 * DAY,
      importance: 0.6,
      kind: "procedure",
      text: `The ${subject} pipeline for ${object} needs its lock file cleared before it can be re-invoked.`,
    });
    cases.push({
      family: "redundancy",
      gold: [duplicates[0]!, facet],
      query: `${subject} pipeline ${object}`,
    });
  }

  return { cases, records };
}

function typo(word: string, random: () => number): string {
  if (word.length < 5) return word;
  const index = 1 + Math.floor(random() * (word.length - 2));
  return `${word.slice(0, index)}${word.slice(index + 1)}`;
}

interface Measurement {
  readonly meanLatencyMs: number;
  readonly ndcg: number;
  readonly recall: number;
  readonly rr: number;
  readonly strategy: string;
}

async function measure(
  strategy: MemoryRetrieval,
  dataset: Dataset,
  vectors: ReadonlyMap<string, readonly number[]>,
): Promise<Measurement> {
  const records = strategy.needsVector
    ? dataset.records.map((record) => ({ ...record, vector: vectors.get(record.id)! }))
    : dataset.records;

  let recall = 0;
  let rr = 0;
  let ndcg = 0;
  const started = performance.now();

  for (const testCase of dataset.cases) {
    const vector = strategy.needsVector ? vectors.get(`query:${testCase.query}`) : undefined;
    const ranked = strategy.rank(buildQuery(testCase.query, NOW, vector), records, TOP_K);
    const ids = ranked.map((entry) => entry.record.id);
    const gold = new Set(testCase.gold);

    recall += ids.filter((id) => gold.has(id)).length / gold.size;
    const firstHit = ids.findIndex((id) => gold.has(id));
    rr += firstHit === -1 ? 0 : 1 / (firstHit + 1);

    let dcg = 0;
    for (const [position, id] of ids.entries()) {
      if (gold.has(id)) dcg += 1 / Math.log2(position + 2);
    }
    let ideal = 0;
    for (let position = 0; position < gold.size; position += 1) {
      ideal += 1 / Math.log2(position + 2);
    }
    ndcg += dcg / ideal;
  }

  const count = dataset.cases.length;
  return {
    meanLatencyMs: (performance.now() - started) / count,
    ndcg: ndcg / count,
    recall: recall / count,
    rr: rr / count,
    strategy: strategy.name,
  };
}

async function familyMeasure(
  strategy: MemoryRetrieval,
  dataset: Dataset,
  vectors: ReadonlyMap<string, readonly number[]>,
  family: Case["family"],
): Promise<Measurement> {
  const subset: Dataset = {
    cases: dataset.cases.filter((testCase) => testCase.family === family),
    records: dataset.records,
  };
  return measure(strategy, subset, vectors);
}

describe("learning memory retrieval benchmark", () => {
  it("ranks the balanced default at the top of the strategy comparison", async () => {
    const dataset = buildDataset();
    const embedding = hashingEmbedding();

    const texts = dataset.records.map((record) => record.text);
    const queries = dataset.cases.map((testCase) => testCase.query);
    const embedded = await embedding.embed([...texts, ...queries]);
    const vectors = new Map<string, readonly number[]>();
    for (const [index, record] of dataset.records.entries()) {
      vectors.set(record.id, embedded[index]!);
    }
    for (const [index, query] of queries.entries()) {
      vectors.set(`query:${query}`, embedded[texts.length + index]!);
    }

    const strategies: readonly MemoryRetrieval[] = [
      bm25(),
      vectorSimilarity(),
      hybrid([bm25(), vectorSimilarity()], { method: "rrf" }),
      hybrid([bm25(), vectorSimilarity()], { method: "weighted", weights: [1, 1] }),
      salienceWeighted(bm25()),
      salienceWeighted(vectorSimilarity()),
      salienceWeighted(hybrid([bm25(), vectorSimilarity()], { method: "rrf" })),
      salienceWeighted(
        hybrid([bm25(), vectorSimilarity()], { method: "weighted", weights: [1, 1] }),
      ),
      diversified(hybrid([bm25(), vectorSimilarity()], { method: "weighted", weights: [1, 1] }), {
        lambda: 0.8,
      }),
      diversified(
        salienceWeighted(
          hybrid([bm25(), vectorSimilarity()], { method: "weighted", weights: [1, 1] }),
        ),
        { lambda: 0.9 },
      ),
      balancedRetrieval(),
    ];

    const measurements: Measurement[] = [];
    for (const strategy of strategies) {
      measurements.push(await measure(strategy, dataset, vectors));
    }

    // Printed so `pnpm test:unit` reports the numbers the research doc quotes.
    console.table(
      measurements.map((measurement) => ({
        "latency (ms/query)": measurement.meanLatencyMs.toFixed(3),
        MRR: measurement.rr.toFixed(3),
        "nDCG@8": measurement.ndcg.toFixed(3),
        "recall@8": measurement.recall.toFixed(3),
        strategy: measurement.strategy,
      })),
    );
    console.table(
      await Promise.all(
        strategies.map(async (strategy) => ({
          exact: (await familyMeasure(strategy, dataset, vectors, "exact")).rr.toFixed(3),
          paraphrase: (await familyMeasure(strategy, dataset, vectors, "paraphrase")).rr.toFixed(3),
          recency: (await familyMeasure(strategy, dataset, vectors, "recency")).rr.toFixed(3),
          redundancy: (await familyMeasure(strategy, dataset, vectors, "redundancy")).ndcg.toFixed(
            3,
          ),
          strategy: strategy.name,
        })),
      ),
    );

    const balanced = measurements.at(-1)!;
    const bestRecall = Math.max(...measurements.map((entry) => entry.recall));
    const bestNdcg = Math.max(...measurements.map((entry) => entry.ndcg));

    const bestRr = Math.max(...measurements.map((entry) => entry.rr));

    expect(dataset.records.length).toBeGreaterThan(200);
    // The default is chosen for aggregate ranking quality: best nDCG@8, within
    // a hair of the best MRR, and near the best recall. No single-strategy
    // baseline is allowed to beat it on nDCG.
    expect(balanced.ndcg).toBeGreaterThanOrEqual(bestNdcg - 0.001);
    expect(balanced.rr).toBeGreaterThanOrEqual(bestRr - 0.02);
    expect(balanced.recall).toBeGreaterThanOrEqual(bestRecall - 0.03);
    expect(balanced.meanLatencyMs).toBeLessThan(25);
  });

  it("shows why each component earns its place", async () => {
    const dataset = buildDataset();
    const embedding = hashingEmbedding();
    const embedded = await embedding.embed([
      ...dataset.records.map((record) => record.text),
      ...dataset.cases.map((testCase) => testCase.query),
    ]);
    const vectors = new Map<string, readonly number[]>();
    for (const [index, record] of dataset.records.entries())
      vectors.set(record.id, embedded[index]!);
    for (const [index, testCase] of dataset.cases.entries()) {
      vectors.set(`query:${testCase.query}`, embedded[dataset.records.length + index]!);
    }

    const lexical = bm25();
    const vector = vectorSimilarity();
    const fused = hybrid([lexical, vector], { method: "weighted", weights: [1, 1] });
    const at = (strategy: MemoryRetrieval, family: Case["family"]) =>
      familyMeasure(strategy, dataset, vectors, family);

    // Fusion is never worse than either input on the family that input is for.
    expect((await at(fused, "exact")).recall).toBeGreaterThanOrEqual(
      (await at(lexical, "exact")).recall,
    );
    expect((await at(fused, "paraphrase")).recall).toBeGreaterThanOrEqual(
      (await at(vector, "paraphrase")).recall,
    );
    // Salience is what separates a superseded claim from its replacement, so
    // it moves the rank of the fresh record, not whether it is retrieved.
    expect((await at(salienceWeighted(fused), "recency")).rr).toBeGreaterThan(
      (await at(fused, "recency")).rr,
    );
    // Diversity is what keeps nine restatements from eating the top slice.
    expect(
      (await at(diversified(salienceWeighted(fused), { lambda: 0.8 }), "redundancy")).ndcg,
    ).toBeGreaterThan((await at(salienceWeighted(fused), "redundancy")).ndcg);
  });
});
