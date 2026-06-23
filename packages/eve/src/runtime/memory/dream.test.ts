import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createBootstrapGenerateResult,
  createBootstrapToolCallResult,
} from "#runtime/agent/bootstrap-model-utils.js";
import { buildDreamContext, runDream } from "#runtime/memory/dream.js";
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { InMemoryTranscriptStore } from "#runtime/transcripts/store.js";

const ROOT = "/mnt/memory";
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

type DreamSessions = readonly { readonly sessionId: string; readonly transcript: string }[];

const SESSIONS: DreamSessions = [{ sessionId: "s1", transcript: "transcript-one" }];

/** A model that never runs (for paths asserted to be no-ops or author-overridden). */
function inertModel(): { model: LanguageModel; calls: () => number } {
  let calls = 0;
  const model = new MockLanguageModelV3({
    modelId: "mock-inert",
    provider: "eve-test",
    doGenerate: async () => {
      calls += 1;
      return createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-inert",
        outputTokens: 1,
        text: "noop",
      });
    },
  });
  return { model, calls: () => calls };
}

/** A model that writes one file via a single `write_file` tool call, then stops. */
function writingModel(path: string, content: string): LanguageModel {
  let step = 0;
  return new MockLanguageModelV3({
    modelId: "mock-write",
    provider: "eve-test",
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return createBootstrapToolCallResult({
          input: { path, content },
          modelId: "mock-write",
          toolCallId: "c1",
          toolName: "write_file",
        });
      }
      return createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-write",
        outputTokens: 1,
        text: "done",
      });
    },
  });
}

async function seededTranscripts(ids: string[]): Promise<InMemoryTranscriptStore> {
  const store = new InMemoryTranscriptStore();
  for (const id of ids) {
    await store.append(id, { text: `turn-${id}` });
  }
  return store;
}

function mountStore(name: string, access: "ro" | "rw", backend: InMemoryMemoryStore): MountedStore {
  return { name, backend, mountPath: `${ROOT}/${name}`, access };
}

describe("buildDreamContext (escape-hatch context)", () => {
  it("exposes the supplied sessions and curated memory access", async () => {
    const backend = new InMemoryMemoryStore();

    const ctx = buildDreamContext({
      backend,
      sessions: SESSIONS,
      model: inertModel().model,
    });

    expect(ctx.sessions).toEqual(SESSIONS);
    expect(await ctx.memory.read("NOTES.md")).toBeNull();
    await ctx.memory.write("NOTES.md", "hello");
    expect(await ctx.memory.read("NOTES.md")).toBe("hello");
    expect(decode(await backend.read("NOTES.md"))).toBe("hello");
  });
});

describe("runDream", () => {
  it("default: runs the dream agent, which writes memory via the file tools", async () => {
    const notes = new InMemoryMemoryStore();
    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore("notes", "rw", notes)],
      dream: {},
      transcriptStore: await seededTranscripts(["s1"]),
    };

    await runDream(config, {
      model: writingModel("/mnt/memory/notes/prefs.md", "metric units"),
      now: 1000,
    });

    expect(decode(await notes.read("prefs.md"))).toBe("metric units");
  });

  it("escape hatch: config.dream.run gets a per-rw-store context over the window", async () => {
    const backend = new InMemoryMemoryStore();
    let receivedSessions: number | null = null;

    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore("notes", "rw", backend)],
      dream: {
        run: async (ctx) => {
          receivedSessions = ctx.sessions.length;
          await ctx.memory.write("CUSTOM.md", "from override");
        },
      },
      transcriptStore: await seededTranscripts(["s1"]),
    };

    await runDream(config, { model: inertModel().model, now: 1000 });

    expect(receivedSessions).toBe(1);
    expect(decode(await backend.read("CUSTOM.md"))).toBe("from override");
  });

  it("is a no-op when the config declares no dream", async () => {
    const backend = new InMemoryMemoryStore();
    const { model, calls } = inertModel();

    await runDream(
      {
        root: ROOT,
        stores: [mountStore("notes", "rw", backend)],
        transcriptStore: await seededTranscripts(["s1"]),
      },
      { model, now: 1000 },
    );

    expect(calls()).toBe(0);
  });

  it("is a no-op when the window holds no sessions", async () => {
    const backend = new InMemoryMemoryStore();
    const { model, calls } = inertModel();

    await runDream(
      {
        root: ROOT,
        stores: [mountStore("notes", "rw", backend)],
        dream: {},
        transcriptStore: new InMemoryTranscriptStore(),
      },
      { model, now: 1000 },
    );

    expect(calls()).toBe(0);
  });
});
