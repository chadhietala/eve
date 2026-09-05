import { describe, expect, it } from "vitest";

import type { MemoryArchitectureContext } from "#public/memory/learning/architectures.js";
import { heuristicDistiller } from "#public/memory/learning/distiller.js";
import { createRecord, type MemoryRecord } from "#public/memory/learning/record.js";
import type { Exchange } from "#public/memory/learning/transcript.js";
import { experience } from "#public/self-improvement/architecture.js";

function context(input: {
  readonly exchange: Partial<Exchange>;
  readonly records?: readonly MemoryRecord[];
}): MemoryArchitectureContext {
  return {
    distiller: heuristicDistiller(),
    exchange: { assistantText: "", toolCalls: [], userText: "", ...input.exchange },
    now: Date.UTC(2026, 8, 1),
    purpose: "improve",
    records: input.records ?? [],
    signal: new AbortController().signal,
    turnSequence: 1,
  };
}

describe("experience", () => {
  it("proposes a rule from an instruction about future behavior", async () => {
    const records = await experience().capture(
      context({ exchange: { userText: "From now on, run the migration check before deploying." } }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("directive");
    expect(records[0]?.key).toMatch(/^directive:/);
  });

  it("stays quiet on an ordinary request", async () => {
    expect(
      await experience().capture(context({ exchange: { userText: "summarize this thread" } })),
    ).toEqual([]);
  });

  it("proposes a rule only for a failure the agent has hit here before", async () => {
    const exchange = {
      toolCalls: [{ failed: true, name: "sync_invoices" }],
      userText: "sync the invoices",
    };

    expect(await experience().capture(context({ exchange }))).toEqual([]);

    const withHistory = await experience().capture(
      context({
        exchange,
        records: [
          createRecord(
            {
              kind: "procedure",
              text: 'When handling "sync the invoices", sync_invoices failed. Check its inputs.',
            },
            Date.now(),
            "p1",
          ),
        ],
      }),
    );

    expect(withHistory).toHaveLength(1);
    expect(withHistory[0]?.text).toContain("Before calling sync_invoices");
    expect(withHistory[0]?.key).toBe("directive:tool:sync_invoices");
  });

  it("writes the same text every time so repetition can confirm it", async () => {
    const records = [
      createRecord(
        { kind: "procedure", text: "When handling something, deploy failed. Check its inputs." },
        Date.now(),
        "p1",
      ),
    ];
    const first = await experience().capture(
      context({
        exchange: { toolCalls: [{ failed: true, name: "deploy" }], userText: "ship it" },
        records,
      }),
    );
    const second = await experience().capture(
      context({
        exchange: { toolCalls: [{ failed: true, name: "deploy" }], userText: "ship it again" },
        records,
      }),
    );

    expect(first[0]?.text).toBe(second[0]?.text);
  });

  it("caps how much one turn can propose", async () => {
    const records = await experience({ maxCandidates: 1 }).capture(
      context({
        exchange: {
          userText:
            "From now on, always check the lockfile. Also, never deploy on Friday. Instead of npm, use pnpm.",
        },
      }),
    );

    expect(records).toHaveLength(1);
  });
});
