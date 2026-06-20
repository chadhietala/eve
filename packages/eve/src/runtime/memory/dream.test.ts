import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createBootstrapGenerateResult,
  type BootstrapGenerateOptions,
  type BootstrapPrompt,
} from "#runtime/agent/bootstrap-model-utils.js";
import { buildDreamContext, defaultDream, runDream } from "#runtime/memory/dream.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const MEMORY_NS: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "agent-1",
  scopeType: "working",
};

const SESSIONS_NS: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "agent-1",
  scopeType: "sessions",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

/**
 * Builds a mock model that returns a fixed `text` and records every prompt it
 * was called with, so a test can assert what the synthesis sent the model.
 */
function createCapturingModel(text: string): {
  model: LanguageModel;
  prompts: BootstrapPrompt[];
} {
  const prompts: BootstrapPrompt[] = [];
  const model = new MockLanguageModelV3({
    modelId: "mock-dream-model",
    provider: "eve-test",
    doGenerate: async (options: BootstrapGenerateOptions) => {
      prompts.push(options.prompt);
      return createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-dream-model",
        outputTokens: 1,
        text,
      });
    },
  });
  return { model, prompts };
}

/** Concatenates all text content across a captured prompt into one string. */
function flattenPromptText(prompt: BootstrapPrompt): string {
  return prompt
    .map((message) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return message.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .join("\n");
    })
    .join("\n");
}

async function seedSessions(
  store: InMemoryMemoryStore,
  sessions: { id: string; transcript: string }[],
): Promise<void> {
  for (const session of sessions) {
    await store.write(
      SESSIONS_NS,
      `sessions/${session.id}/transcript.jsonl`,
      encoder.encode(session.transcript),
      `seed-${session.id}`,
    );
  }
}

describe("buildDreamContext", () => {
  it("reads transcripts from the sessions namespace keyed by session id", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [
      { id: "s1", transcript: "transcript-one" },
      { id: "s2", transcript: "transcript-two" },
    ]);
    const { model } = createCapturingModel("ignored");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });

    const byId = Object.fromEntries(ctx.sessions.map((s) => [s.sessionId, s.transcript]));
    expect(byId).toEqual({ s1: "transcript-one", s2: "transcript-two" });
  });

  it("exposes memory read/write/list bound to the memory namespace", async () => {
    const store = new InMemoryMemoryStore();
    const { model } = createCapturingModel("ignored");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });

    expect(await ctx.memory.read("NOTES.md")).toBeNull();
    await ctx.memory.write("NOTES.md", "hello");
    expect(await ctx.memory.read("NOTES.md")).toBe("hello");
    expect(await ctx.memory.list("")).toEqual(["NOTES.md"]);

    // The write landed in the memory namespace, not the sessions namespace.
    expect(decode(await store.read(MEMORY_NS, "NOTES.md"))).toBe("hello");
    expect(await store.read(SESSIONS_NS, "NOTES.md")).toBeNull();
  });
});

describe("defaultDream", () => {
  it("calls the model and writes the synthesis to MEMORY.md", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [{ id: "s1", transcript: "the user prefers metric units" }]);
    const { model, prompts } = createCapturingModel("# Memory\nUser prefers metric units.");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });
    await defaultDream(ctx);

    expect(prompts).toHaveLength(1);
    expect(decode(await store.read(MEMORY_NS, "MEMORY.md"))).toBe(
      "# Memory\nUser prefers metric units.",
    );
  });

  it("never writes to the sessions namespace (transcripts stay unchanged)", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [
      { id: "s1", transcript: "transcript-one" },
      { id: "s2", transcript: "transcript-two" },
    ]);
    const { model } = createCapturingModel("consolidated");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });
    await defaultDream(ctx);

    // The sessions area is untouched: both transcripts present and verbatim.
    expect(decode(await store.read(SESSIONS_NS, "sessions/s1/transcript.jsonl"))).toBe(
      "transcript-one",
    );
    expect(decode(await store.read(SESSIONS_NS, "sessions/s2/transcript.jsonl"))).toBe(
      "transcript-two",
    );
    const sessionEntries = await store.list(SESSIONS_NS, "sessions/");
    expect(sessionEntries.map((e) => e.path).sort()).toEqual([
      "sessions/s1/transcript.jsonl",
      "sessions/s2/transcript.jsonl",
    ]);
  });

  it("incorporates an existing MEMORY.md into the model prompt", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(MEMORY_NS, "MEMORY.md", encoder.encode("PRIOR: likes dark mode"), "prior");
    await seedSessions(store, [{ id: "s1", transcript: "new session content" }]);
    const { model, prompts } = createCapturingModel("merged");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });
    await defaultDream(ctx);

    const promptText = flattenPromptText(prompts[0]!);
    expect(promptText).toContain("PRIOR: likes dark mode");
    expect(promptText).toContain("new session content");
  });

  it("includes the author instructions when provided", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [{ id: "s1", transcript: "session" }]);
    const { model, prompts } = createCapturingModel("ok");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
      instructions: "Keep only project decisions.",
    });
    await defaultDream(ctx);

    expect(flattenPromptText(prompts[0]!)).toContain("Keep only project decisions.");
  });

  it("is a no-op when there are no sessions", async () => {
    const store = new InMemoryMemoryStore();
    const { model, prompts } = createCapturingModel("should not run");

    const ctx = await buildDreamContext({
      store,
      memoryNamespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
      model,
    });
    await defaultDream(ctx);

    expect(prompts).toHaveLength(0);
    expect(await store.read(MEMORY_NS, "MEMORY.md")).toBeNull();
  });
});

describe("runDream", () => {
  function baseConfig(store: InMemoryMemoryStore): MemoryConfig {
    return {
      root: "/memory",
      store,
      namespace: MEMORY_NS,
      sessionsNamespace: SESSIONS_NS,
    };
  }

  it("uses config.dream.run when the author supplied an override", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [{ id: "s1", transcript: "t1" }]);
    const { model } = createCapturingModel("default-output");
    let receivedSessions: number | null = null;

    const config: MemoryConfig = {
      ...baseConfig(store),
      dream: {
        run: async (ctx) => {
          receivedSessions = ctx.sessions.length;
          await ctx.memory.write("CUSTOM.md", "from override");
        },
      },
    };

    await runDream(config, { model });

    expect(receivedSessions).toBe(1);
    expect(decode(await store.read(MEMORY_NS, "CUSTOM.md"))).toBe("from override");
    // The default did not run, so MEMORY.md was never written.
    expect(await store.read(MEMORY_NS, "MEMORY.md")).toBeNull();
  });

  it("runs the default synthesis when no run override is present", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [{ id: "s1", transcript: "t1" }]);
    const { model, prompts } = createCapturingModel("default-synthesis");

    const config: MemoryConfig = {
      ...baseConfig(store),
      dream: { instructions: "be terse" },
    };

    await runDream(config, { model });

    expect(prompts).toHaveLength(1);
    expect(decode(await store.read(MEMORY_NS, "MEMORY.md"))).toBe("default-synthesis");
    expect(flattenPromptText(prompts[0]!)).toContain("be terse");
  });

  it("is a no-op when the config declares no dream", async () => {
    const store = new InMemoryMemoryStore();
    await seedSessions(store, [{ id: "s1", transcript: "t1" }]);
    const { model, prompts } = createCapturingModel("never");

    await runDream(baseConfig(store), { model });

    expect(prompts).toHaveLength(0);
    expect(await store.read(MEMORY_NS, "MEMORY.md")).toBeNull();
  });
});
