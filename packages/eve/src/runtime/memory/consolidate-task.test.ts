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
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { InMemoryTimerStore } from "#runtime/timer/store.js";
import { armTimer } from "#runtime/timer/timer.js";

const AGENT_ID = "agent-1";
const ROOT = "/mnt/memory";
const STORE = "notes";

const CURATED_NS = resolveStoreNamespace(STORE);
const TRANSCRIPTS_NS = resolveTranscriptsNamespace(STORE);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

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

async function seedTranscripts(backend: InMemoryMemoryStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await backend.write(
      TRANSCRIPTS_NS,
      `transcripts/${id}.jsonl`,
      encoder.encode(`transcript-${id}`),
      `seed-${id}`,
    );
  }
}

function mountStore(backend: InMemoryMemoryStore, access: "ro" | "rw" = "rw"): MountedStore {
  return { name: STORE, backend, mountPath: `${ROOT}/${STORE}`, access };
}

interface ConfigOptions {
  readonly dream?: MemoryConfig["dream"];
}

function makeConfig(backend: InMemoryMemoryStore, options: ConfigOptions = {}): MemoryConfig {
  const config: MemoryConfig = {
    root: ROOT,
    stores: [mountStore(backend)],
  };
  if (options.dream !== undefined) {
    return { ...config, dream: options.dream };
  }
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
  it("counts transcripts/*.jsonl across rw stores, skipping stray files", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1", "s2", "s3"]);
    await backend.write(TRANSCRIPTS_NS, "transcripts/notes.txt", encoder.encode("x"), "stray");

    expect(await countSessionTranscripts(makeConfig(backend))).toBe(3);
  });

  it("does not count transcripts in a ro store", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1", "s2"]);
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(backend, "ro")],
      dream: {},
    };
    expect(await countSessionTranscripts(config)).toBe(0);
  });
});

describe("meetsMinSessions", () => {
  it("passes when no floor is declared", async () => {
    const backend = new InMemoryMemoryStore();
    expect(await meetsMinSessions(makeConfig(backend, { dream: {} }))).toBe(true);
  });

  it("passes when the session count meets the floor", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1", "s2"]);
    const config = makeConfig(backend, { dream: { schedule: { minSessions: 2 } } });
    expect(await meetsMinSessions(config)).toBe(true);
  });

  it("fails when the session count is below the floor", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1"]);
    const config = makeConfig(backend, { dream: { schedule: { minSessions: 2 } } });
    expect(await meetsMinSessions(config)).toBe(false);
  });
});

describe("runDueConsolidations", () => {
  it("runs the dream for a due timer and consumes it", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100);
    const { model, calls } = createModel("# Consolidated memory");
    const config = makeConfig(backend);

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => config,
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 1 });
    expect(calls()).toBe(1);
    expect(decode(await backend.read(CURATED_NS, "MEMORY.md"))).toBe("# Consolidated memory");

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
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100);
    const { model, calls } = createModel("should not run");
    const config = makeConfig(backend, { dream: { schedule: { minSessions: 2 } } });

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => config,
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
    expect(await backend.read(CURATED_NS, "MEMORY.md")).toBeNull();
  });

  it("does not run a not-yet-due timer", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1"]);
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 1000);
    const { model, calls } = createModel("nope");

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => makeConfig(backend),
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
    const record = await timerStore.get(consolidationTimerKey(AGENT_ID));
    expect(record?.status).toBe("fired");
  });

  it("ignores a due timer whose task is not the consolidate task", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, ["s1"]);
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
      loadConfig: async () => makeConfig(backend),
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
  });

  it("skips a malformed payload without an agentId", async () => {
    const backend = new InMemoryMemoryStore();
    const timerStore = new InMemoryTimerStore();
    await armConsolidation(timerStore, 100, {});
    const { model, calls } = createModel("nope");

    const result = await runDueConsolidations({
      timerStore,
      now: 100,
      loadConfig: async () => makeConfig(backend),
      resolveModel: async () => model,
    });

    expect(result).toEqual({ ran: 0 });
    expect(calls()).toBe(0);
  });
});
