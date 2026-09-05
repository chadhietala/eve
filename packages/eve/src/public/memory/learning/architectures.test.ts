import { describe, expect, it } from "vitest";

import {
  episodic,
  procedural,
  reflective,
  semantic,
  type MemoryArchitectureContext,
} from "#public/memory/learning/architectures.js";
import { heuristicDistiller, type MemoryDistiller } from "#public/memory/learning/distiller.js";
import { createRecord, type MemoryRecord } from "#public/memory/learning/record.js";
import type { Exchange } from "#public/memory/learning/transcript.js";

const NOW = Date.UTC(2026, 8, 1);

function context(input: {
  readonly distiller?: MemoryDistiller;
  readonly exchange: Partial<Exchange>;
  readonly records?: readonly MemoryRecord[];
  readonly turnSequence?: number;
}): MemoryArchitectureContext {
  return {
    distiller: input.distiller ?? heuristicDistiller(),
    exchange: {
      assistantText: "",
      toolCalls: [],
      userText: "",
      ...input.exchange,
    },
    now: NOW,
    purpose: "profile",
    records: input.records ?? [],
    signal: new AbortController().signal,
    turnSequence: input.turnSequence ?? 1,
  };
}

describe("episodic", () => {
  it("summarizes one turn, and treats a failed tool call as the notable part", async () => {
    const [record] = await episodic().capture(
      context({
        exchange: {
          assistantText: "Retried against the replica and it worked.",
          toolCalls: [
            { failed: true, name: "query_db" },
            { failed: false, name: "query_replica" },
          ],
          userText: "Pull yesterday's signups.",
        },
      }),
    );

    expect(record?.kind).toBe("episode");
    expect(record?.text).toContain("Asked: Pull yesterday's signups.");
    expect(record?.text).toContain("Used: query_db, query_replica");
    expect(record?.text).toContain("Failed: query_db");
    expect(record?.importance).toBeGreaterThan(0.5);
  });

  it("writes nothing for an empty exchange", async () => {
    expect(await episodic().capture(context({ exchange: {} }))).toEqual([]);
  });
});

describe("semantic", () => {
  it("keys extracted facts so a later statement replaces the earlier one", async () => {
    const records = await semantic().capture(
      context({ exchange: { userText: "I always deploy from the main branch." } }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("fact");
    expect(records[0]?.key).toBeDefined();
  });

  it("extracts nothing from a turn with no durable statement", async () => {
    expect(
      await semantic().capture(context({ exchange: { userText: "what time is the standup" } })),
    ).toEqual([]);
  });
});

describe("procedural", () => {
  it("records the sequence that worked and the step that failed", async () => {
    const records = await procedural().capture(
      context({
        exchange: {
          toolCalls: [
            { failed: false, name: "read_file" },
            { failed: true, name: "write_file" },
            { failed: false, name: "bash" },
          ],
          userText: "Bump the changelog for the release.",
        },
      }),
    );

    expect(records.map((record) => record.text)).toEqual([
      expect.stringContaining("read_file → bash"),
      expect.stringContaining("write_file failed"),
    ]);
    expect(records.every((record) => record.kind === "procedure")).toBe(true);
  });

  it("ignores a turn with too few steps to be a procedure", async () => {
    expect(
      await procedural().capture(
        context({ exchange: { toolCalls: [{ failed: false, name: "bash" }], userText: "ls" } }),
      ),
    ).toEqual([]);
  });
});

describe("reflective", () => {
  const episodes = Array.from({ length: 6 }, (_unused, index) =>
    createRecord(
      {
        kind: "episode",
        text: `Asked: rotate the vault credential again · Result: rotated key ${index}`,
      },
      NOW - index * 1_000,
      `e${index}`,
    ),
  );

  it("only reflects on its interval", async () => {
    expect(
      await reflective({ everyTurns: 5 }).capture(
        context({ exchange: {}, records: episodes, turnSequence: 4 }),
      ),
    ).toEqual([]);
  });

  it("promotes a recurring theme to an insight without a model", async () => {
    const records = await reflective({ everyTurns: 5 }).capture(
      context({ exchange: {}, records: episodes, turnSequence: 5 }),
    );

    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.kind).toBe("insight");
    expect(records[0]?.text).toMatch(/recurs across \d+ recent turns/);
  });

  it("prefers a distiller's insights when one produces them", async () => {
    const distiller: MemoryDistiller = {
      id: "test",
      async distill() {
        return [{ kind: "insight", text: "Credential rotation is a weekly chore." }];
      },
    };

    const records = await reflective({ everyTurns: 1 }).capture(
      context({ distiller, exchange: {}, records: episodes, turnSequence: 1 }),
    );

    expect(records).toEqual([{ kind: "insight", text: "Credential rotation is a weekly chore." }]);
  });
});
