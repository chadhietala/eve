import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { pruneTranscripts, runDreamTask } from "#runtime/memory/dream-task.js";
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { InMemoryTranscriptStore } from "#runtime/transcripts/store.js";

const ROOT = "/mnt/memory";
const STORE = "notes";

const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

/**
 * A model that fails if invoked. The orchestration tests drive dream
 * through a deterministic `run` override (see {@link writeDream}), which never
 * calls a model — so reaching this proves a wiring bug.
 */
const INERT_MODEL: LanguageModel = new MockLanguageModelV3({
  modelId: "inert-model",
  provider: "eve-test",
  doGenerate: async () => {
    throw new Error("model must not be called for a `run` override dream");
  },
});

/**
 * A `dream` whose `run` override deterministically writes `content` to notes.md
 * in each rw store. The default dream is an agent (model tool-calling); these
 * orchestration tests use an override so they assert wiring, not synthesis.
 */
function writeDream(content: string): MemoryConfig["dream"] {
  return {
    run: async (ctx) => {
      await ctx.memory.write("notes.md", content);
    },
  };
}

/** A transcript log seeded with one turn for each given session id. */
async function seededLog(
  ids: string[],
  now: () => number = () => 0,
): Promise<InMemoryTranscriptStore> {
  const log = new InMemoryTranscriptStore(now);
  for (const id of ids) {
    await log.append(id, { text: `turn-${id}` });
  }
  return log;
}

function mountStore(backend: InMemoryMemoryStore, access: "ro" | "rw" = "rw"): MountedStore {
  return { name: STORE, backend, mountPath: `${ROOT}/${STORE}`, access };
}

describe("runDreamTask", () => {
  it("runs the dream and writes curated memory", async () => {
    const backend = new InMemoryMemoryStore();
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(backend)],
      dream: writeDream("# Curated memory"),
      transcriptStore: await seededLog(["s1"]),
    };

    const result = await runDreamTask(config, { model: INERT_MODEL, now: 100 });

    expect(result).toEqual({ ran: 1 });
    expect(decode(await backend.read("notes.md"))).toBe("# Curated memory");
  });

  it("folds every rw store from the shared transcript window", async () => {
    const backendA = new InMemoryMemoryStore();
    const backendB = new InMemoryMemoryStore();
    const log = await seededLog(["s1"]);
    const config: MemoryConfig = {
      root: ROOT,
      stores: [
        { name: "notes", backend: backendA, mountPath: `${ROOT}/notes`, access: "rw" },
        { name: "facts", backend: backendB, mountPath: `${ROOT}/facts`, access: "rw" },
      ],
      dream: writeDream("# Curated"),
      transcriptStore: log,
    };

    const result = await runDreamTask(config, { model: INERT_MODEL, now: 100 });

    expect(result).toEqual({ ran: 1 });
    expect(decode(await backendA.read("notes.md"))).toBe("# Curated");
    expect(decode(await backendB.read("notes.md"))).toBe("# Curated");
    // The transcript log (the dream's input) is never mutated.
    expect((await log.list()).map((i) => i.sessionId)).toEqual(["s1"]);
  });

  it("is a no-op when the agent declares no dream", async () => {
    const backend = new InMemoryMemoryStore();
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(backend)],
      transcriptStore: await seededLog(["s1"]),
    };

    const result = await runDreamTask(config, { model: INERT_MODEL, now: 100 });

    expect(result).toEqual({ ran: 0 });
    expect(await backend.read("notes.md")).toBeNull();
  });

  it("is a no-op for a ro-only agent (no rw stores to dream)", async () => {
    const backend = new InMemoryMemoryStore();
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(backend, "ro")],
      dream: writeDream("should not write"),
      transcriptStore: await seededLog(["s1"]),
    };

    // The dream is declared, so it "ran", but runDream skips a ro-only agent.
    const result = await runDreamTask(config, { model: INERT_MODEL, now: 100 });

    expect(result).toEqual({ ran: 1 });
    expect(await backend.read("notes.md")).toBeNull();
  });

  it("prunes the transcript log per retention after dreaming", async () => {
    let clock = 0;
    const log = new InMemoryTranscriptStore(() => clock);
    clock = 100;
    await log.append("old", { n: 1 });
    clock = 100_000;
    await log.append("fresh", { n: 1 });

    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(new InMemoryMemoryStore())],
      dream: writeDream("# Curated"),
      transcriptStore: log,
      transcriptRetention: 50_000,
    };

    await runDreamTask(config, { model: INERT_MODEL, now: 100_000 });

    // "old" is older than maxAge=50s relative to now=100_000 → pruned; "fresh" stays.
    expect((await log.list()).map((i) => i.sessionId)).toEqual(["fresh"]);
  });
});

describe("pruneTranscripts", () => {
  it("removes transcripts older than the retention maxAge", async () => {
    let clock = 0;
    const log = new InMemoryTranscriptStore(() => clock);
    clock = 1_000;
    await log.append("old", { n: 1 });
    clock = 10_000;
    await log.append("fresh", { n: 1 });

    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(new InMemoryMemoryStore())],
      dream: {},
      transcriptStore: log,
      transcriptRetention: 5_000,
    };

    await pruneTranscripts(config, 10_000);
    expect((await log.list()).map((i) => i.sessionId)).toEqual(["fresh"]);
  });

  it("is a no-op when no retention is declared", async () => {
    const log = await seededLog(["s1"]);
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore(new InMemoryMemoryStore())],
      dream: {},
      transcriptStore: log,
    };
    await pruneTranscripts(config, 1_000_000);
    expect((await log.list()).length).toBe(1);
  });
});
