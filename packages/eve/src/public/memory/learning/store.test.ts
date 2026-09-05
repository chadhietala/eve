import { describe, expect, it } from "vitest";

import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { createRecord, type MemoryRecord } from "#public/memory/learning/record.js";
import { createLearningStore, deserialize, serialize } from "#public/memory/learning/store.js";

const signal = new AbortController().signal;
const NOW = Date.UTC(2026, 8, 1);

function record(text: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    ...createRecord({ kind: "fact", text }, NOW, text.slice(0, 6)),
    ...overrides,
  };
}

describe("learning store serialization", () => {
  it("round-trips every field, including a quantized vector", () => {
    const original = record("the deploy runs nightly", {
      accessCount: 3,
      key: "deploy-nightly",
      source: "turn:1",
      tags: ["ops"],
      vector: [1, -1, 0.5],
      vectorId: "hashing-v1:3:0.5",
    });

    const [restored] = deserialize(serialize([original]));

    expect(restored).toMatchObject({
      accessCount: 3,
      id: original.id,
      key: "deploy-nightly",
      kind: "fact",
      source: "turn:1",
      tags: ["ops"],
      text: "the deploy runs nightly",
      vectorId: "hashing-v1:3:0.5",
    });
    expect(restored!.vector![0]).toBeCloseTo(1, 2);
    expect(restored!.vector![1]).toBeCloseTo(-1, 2);
    expect(restored!.vector![2]).toBeCloseTo(0.5, 2);
  });

  it("rejects a document written by another version", () => {
    expect(() => deserialize(JSON.stringify({ records: [], version: 99 }))).toThrow(
      /version 1 record set/,
    );
    expect(() => deserialize("not json")).toThrow(/not valid JSON/);
  });
});

describe("createLearningStore", () => {
  it("reads back what it writes, per scope key", async () => {
    const store = createLearningStore({ backend: inMemory() });

    await store.update({
      key: "scope-a",
      mutate: () => [record("a fact for a")],
      now: NOW,
      signal,
    });

    expect((await store.read({ key: "scope-a", signal })).map((entry) => entry.text)).toEqual([
      "a fact for a",
    ]);
    expect(await store.read({ key: "scope-b", signal })).toEqual([]);
  });

  it("evicts the least valuable records past the cap", async () => {
    const store = createLearningStore({ backend: inMemory(), maxRecords: 3 });

    const stored = await store.update({
      key: "scope",
      mutate: () => [
        record("low value", { confidence: 0.1, importance: 0.1 }),
        record("high value", { confidence: 0.95, importance: 0.95 }),
        record("recalled often", { accessCount: 20, confidence: 0.6, importance: 0.6 }),
        record("middling", { confidence: 0.5, importance: 0.5 }),
      ],
      now: NOW,
      signal,
    });

    expect(stored).toHaveLength(3);
    expect(stored.map((entry) => entry.text)).not.toContain("low value");
    expect(stored.map((entry) => entry.text)).toContain("high value");
  });

  it("prefers a fresh record over an equally rated stale one", async () => {
    const store = createLearningStore({ backend: inMemory(), maxRecords: 1 });

    const stored = await store.update({
      key: "scope",
      mutate: () => [
        record("stale", { updatedAt: NOW - 365 * 24 * 60 * 60 * 1_000 }),
        record("fresh", { updatedAt: NOW }),
      ],
      now: NOW,
      signal,
    });

    expect(stored.map((entry) => entry.text)).toEqual(["fresh"]);
  });

  it("retries a conflicting write against the newest document", async () => {
    const backend = inMemory();
    const store = createLearningStore({ backend });
    let raced = false;

    await store.update({
      key: "scope",
      mutate: (current) => {
        if (!raced) {
          raced = true;
          // Simulate another writer landing between this read and its write.
          void backend.write({
            content: serialize([record("written by another turn")]),
            expectedVersion: null,
            key: "scope",
            signal,
          });
        }
        return [...current, record("written by this turn")];
      },
      now: NOW,
      signal,
    });

    const stored = await store.read({ key: "scope", signal });
    expect(stored.map((entry) => entry.text).toSorted()).toEqual([
      "written by another turn",
      "written by this turn",
    ]);
  });
});
