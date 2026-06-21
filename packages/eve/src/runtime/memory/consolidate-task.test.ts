import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createBootstrapGenerateResult,
  type BootstrapGenerateOptions,
} from "#runtime/agent/bootstrap-model-utils.js";
import {
  CONSOLIDATE_TASK_NAME,
  consolidationTimerKey,
  countSessionTranscripts,
  meetsMinSessions,
  runDueConsolidations,
} from "#runtime/memory/consolidate-task.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";
import { InMemoryTimerStore } from "#runtime/timer/store.js";
import { armTimer } from "#runtime/timer/timer.js";

const AGENT_ID = "agent-1";

const MEMORY_NS: MemoryNamespace = {
  agentId: AGENT_ID,
  scopeId: AGENT_ID,
  scopeType: "working",
};

const SESSIONS_NS: MemoryNamespace = {
  agentId: AGENT_ID,
  scopeId: AGENT_ID,
  scopeType: "sessions",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

/** A mock model that returns fixed `text` and counts how often it was called. */
function createModel(text: string): { model: LanguageModel; calls: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV3({
    modelId: "mock-consolidate-model",
    provider: "eve-test",
    doGenerate: async (_options: BootstrapGenerateOptions) => {
      calls += 1;
      return createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-consolidate-model",
        outputTokens: 1,
        text,
      });
    },
  });
  return { model, calls: () => calls };
}

async function seedSessions(store: InMemoryMemoryStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await store.write(
      SESSIONS_NS,
      `sessions/${id}/transcript.jsonl`,
      encoder.encode(`transcript-${id}`),
      `seed-${id}`,
    );
  }
}

interface ConfigOptions {
  readonly dream?: MemoryConfig["dream"];
}

function makeConfig(store: InMemoryMemoryStore, options: ConfigOptions = {}): MemoryConfig {
  const config: MemoryConfig = {
    root: "/memory",
    store,
    namespace: MEMORY_NS,
    sessionsNamespace: SESSIONS_NS,
  };
  if (options.dream !== undefined) {
    return { ...config, dream: options.dream };
  }
  // Default to a dream with no gate so the dream actually runs.
  return { ...config, dream: {} };
}

async function armConsolidation(
  store: InMemoryTimerStore,
  dueAt: number,
  payload: Record<string, unknown> = { agentId: AGENT_ID },
): Promise<void> {
  await armTimer(store, {
    key: consolidationTimerKey(AGENT_ID),
    afterMs: dueAt,
    now: 0,
    task: { name: CONSOLIDATE_TASK_NAME, payload },
  });
}

describe("countSessionTranscripts", () => {
  it("counts only transcript.jsonl entries under sessions/", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, ["s1", "s2", "s3"]);
    // A stray non-transcript file must not be counted.
    await store.write(SESSIONS_NS, "sessions/s1/notes.txt", encoder.encode("x"), "stray");

    expect(await countSessionTranscripts(store, SESSIONS_NS)).toBe(3);
  });
});

describe("meetsMinSessions", () => {
  it("passes when no floor is declared", async () => {
    const store = new InMemoryMemoryStore();
    expect(await meetsMinSessions(makeConfig(store, { dream: {} }), store)).toBe(true);
  });

  it("passes when the session count meets the floor", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, ["s1", "s2"]);
    const config = makeConfig(store, { dream: { schedule: { minSessions: 2 } } });
    expect(await meetsMinSessions(config, store)).toBe(true);
  });

  it("fails when the session count is below the floor", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, ["s1"]);
    const config = makeConfig(store, { dream: { schedule: { minSessions: 2 } } });
    expect(await meetsMinSessions(config, store)).toBe(false);
  });
});

describe("runDueConsolidations", () => {
  it("runs the dream for a due timer and consumes it", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await seedSessions(memoryStore, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100);
    const { model, calls } = createModel("# Consolidated memory");
    const config = makeConfig(memoryStore);

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => config,
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 1 });
    expect(calls()).toBe(1);
    expect(decode(await memoryStore.read(MEMORY_NS, "MEMORY.md"))).toBe("# Consolidated memory");

    // A second sweep at the same instant must not re-run the consumed timer.
    const second = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => config,
      resolveModel: async () => model,
    });
    expect(second).toEqual({ ran: 0 });
    expect(calls()).toBe(1);
  });

  it("skips a config below its minSessions floor (no dream, no MEMORY.md)", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await seedSessions(memoryStore, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100);
    const { model, calls } = createModel("should not run");
    const config = makeConfig(memoryStore, { dream: { schedule: { minSessions: 2 } } });

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => config,
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
    expect(await memoryStore.read(MEMORY_NS, "MEMORY.md")).toBeNull();
  });

  it("does not run a not-yet-due timer", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await seedSessions(memoryStore, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 1000);
    const { model, calls } = createModel("nope");

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => makeConfig(memoryStore),
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
  });

  it("skips gracefully when loadConfig returns undefined (agent gone)", async () => {
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100);
    const { model, calls } = createModel("nope");
    let resolveModelCalled = false;

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => undefined,
      resolveModel: async () => {
        resolveModelCalled = true;
        return model;
      },
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
    expect(resolveModelCalled).toBe(false);
    // The timer was still claimed (consumed) — exactly-once even when skipped.
    const record = await timerStore.get(consolidationTimerKey(AGENT_ID));
    expect(record?.status).toBe("fired");
  });

  it("ignores a due timer whose task is not the consolidate task", async () => {
    const memoryStore = new InMemoryMemoryStore();
    await seedSessions(memoryStore, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armTimer(timerStore, {
      key: "other:thing",
      afterMs: 100,
      now: 0,
      task: { name: "eve.something.else", payload: { agentId: AGENT_ID } },
    });
    const { model, calls } = createModel("nope");

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => makeConfig(memoryStore),
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
  });

  it("skips a malformed payload without an agentId", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100, {});
    const { model, calls } = createModel("nope");

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => makeConfig(memoryStore),
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
  });
});
