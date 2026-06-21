import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import {
  createBootstrapGenerateResult,
  type BootstrapGenerateOptions,
  type BootstrapPrompt,
} from "#runtime/agent/bootstrap-model-utils.js";
import { buildDreamContext, defaultDream, runDream } from "#runtime/memory/dream.js";
import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

const CURATED_NS = resolveStoreNamespace();
const TRANSCRIPTS_NS = resolveTranscriptsNamespace();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : decoder.decode(bytes);
}

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

async function seedTranscripts(
  backend: InMemoryMemoryStore,
  sessions: { id: string; transcript: string }[],
): Promise<void> {
  for (const session of sessions) {
    await backend.write(
      TRANSCRIPTS_NS,
      `transcripts/${session.id}.jsonl`,
      encoder.encode(session.transcript),
      `seed-${session.id}`,
    );
  }
}

describe("buildDreamContext", () => {
  it("reads sessions from transcripts/*.jsonl keyed by session id", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, [
      { id: "s1", transcript: "transcript-one" },
      { id: "s2", transcript: "transcript-two" },
    ]);
    const { model } = createCapturingModel("ignored");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });

    const byId = Object.fromEntries(ctx.sessions.map((s) => [s.sessionId, s.transcript]));
    expect(byId).toEqual({ s1: "transcript-one", s2: "transcript-two" });
  });

  it("exposes memory read/write/list bound to the curated namespace", async () => {
    const backend = new InMemoryMemoryStore();
    const { model } = createCapturingModel("ignored");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });

    expect(await ctx.memory.read("NOTES.md")).toBeNull();
    await ctx.memory.write("NOTES.md", "hello");
    expect(await ctx.memory.read("NOTES.md")).toBe("hello");
    expect(await ctx.memory.list("")).toEqual(["NOTES.md"]);

    // The write landed in the curated namespace, not the transcripts namespace.
    expect(decode(await backend.read(CURATED_NS, "NOTES.md"))).toBe("hello");
    expect(await backend.read(TRANSCRIPTS_NS, "NOTES.md")).toBeNull();
  });
});

describe("defaultDream", () => {
  it("calls the model and writes the synthesis to MEMORY.md in the curated namespace", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, [{ id: "s1", transcript: "the user prefers metric units" }]);
    const { model, prompts } = createCapturingModel("# Memory\nUser prefers metric units.");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });
    await defaultDream(ctx);

    expect(prompts).toHaveLength(1);
    expect(decode(await backend.read(CURATED_NS, "MEMORY.md"))).toBe(
      "# Memory\nUser prefers metric units.",
    );
  });

  it("never writes to the transcripts namespace (transcripts stay unchanged)", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, [
      { id: "s1", transcript: "transcript-one" },
      { id: "s2", transcript: "transcript-two" },
    ]);
    const { model } = createCapturingModel("consolidated");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });
    await defaultDream(ctx);

    expect(decode(await backend.read(TRANSCRIPTS_NS, "transcripts/s1.jsonl"))).toBe(
      "transcript-one",
    );
    expect(decode(await backend.read(TRANSCRIPTS_NS, "transcripts/s2.jsonl"))).toBe(
      "transcript-two",
    );
    const entries = await backend.list(TRANSCRIPTS_NS, "transcripts/");
    expect(entries.map((e) => e.path).sort()).toEqual([
      "transcripts/s1.jsonl",
      "transcripts/s2.jsonl",
    ]);
  });

  it("incorporates an existing MEMORY.md into the model prompt", async () => {
    const backend = new InMemoryMemoryStore();
    await backend.write(CURATED_NS, "MEMORY.md", encoder.encode("PRIOR: likes dark mode"), "prior");
    await seedTranscripts(backend, [{ id: "s1", transcript: "new session content" }]);
    const { model, prompts } = createCapturingModel("merged");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });
    await defaultDream(ctx);

    const promptText = flattenPromptText(prompts[0]!);
    expect(promptText).toContain("PRIOR: likes dark mode");
    expect(promptText).toContain("new session content");
  });

  it("includes the author instructions when provided", async () => {
    const backend = new InMemoryMemoryStore();
    await seedTranscripts(backend, [{ id: "s1", transcript: "session" }]);
    const { model, prompts } = createCapturingModel("ok");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
      instructions: "Keep only project decisions.",
    });
    await defaultDream(ctx);

    expect(flattenPromptText(prompts[0]!)).toContain("Keep only project decisions.");
  });

  it("is a no-op when there are no sessions", async () => {
    const backend = new InMemoryMemoryStore();
    const { model, prompts } = createCapturingModel("should not run");

    const ctx = await buildDreamContext({
      backend,
      curatedNamespace: CURATED_NS,
      transcriptsNamespace: TRANSCRIPTS_NS,
      model,
    });
    await defaultDream(ctx);

    expect(prompts).toHaveLength(0);
    expect(await backend.read(CURATED_NS, "MEMORY.md")).toBeNull();
  });
});

describe("runDream", () => {
  const ROOT = "/mnt/memory";

  function mountStore(
    name: string,
    access: "ro" | "rw",
    backend: InMemoryMemoryStore,
  ): MountedStore {
    return { name, backend, mountPath: `${ROOT}/${name}`, access };
  }

  it("runs the dream per rw store and skips ro stores", async () => {
    const a = new InMemoryMemoryStore();
    const b = new InMemoryMemoryStore();
    const ro = new InMemoryMemoryStore();
    await a.write(
      resolveTranscriptsNamespace(),
      "transcripts/s1.jsonl",
      encoder.encode("ta"),
      "ka",
    );
    await b.write(
      resolveTranscriptsNamespace(),
      "transcripts/s1.jsonl",
      encoder.encode("tb"),
      "kb",
    );
    await ro.write(
      resolveTranscriptsNamespace(),
      "transcripts/s1.jsonl",
      encoder.encode("tro"),
      "kro",
    );
    const { model } = createCapturingModel("synth");

    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore("a", "rw", a), mountStore("b", "rw", b), mountStore("ro", "ro", ro)],
      dream: {},
    };

    await runDream(config, { model });

    expect(decode(await a.read(resolveStoreNamespace(), "MEMORY.md"))).toBe("synth");
    expect(decode(await b.read(resolveStoreNamespace(), "MEMORY.md"))).toBe("synth");
    // The ro store was never consolidated.
    expect(await ro.read(resolveStoreNamespace(), "MEMORY.md")).toBeNull();
  });

  it("uses config.dream.run when the author supplied an override", async () => {
    const backend = new InMemoryMemoryStore();
    await backend.write(
      resolveTranscriptsNamespace(),
      "transcripts/s1.jsonl",
      encoder.encode("t1"),
      "k1",
    );
    const { model } = createCapturingModel("default-output");
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
    };

    await runDream(config, { model });

    expect(receivedSessions).toBe(1);
    expect(decode(await backend.read(resolveStoreNamespace(), "CUSTOM.md"))).toBe("from override");
    expect(await backend.read(resolveStoreNamespace(), "MEMORY.md")).toBeNull();
  });

  it("is a no-op when the config declares no dream", async () => {
    const backend = new InMemoryMemoryStore();
    await backend.write(
      resolveTranscriptsNamespace(),
      "transcripts/s1.jsonl",
      encoder.encode("t1"),
      "k1",
    );
    const { model, prompts } = createCapturingModel("never");

    const config: MemoryConfig = {
      root: ROOT,
      stores: [mountStore("notes", "rw", backend)],
    };

    await runDream(config, { model });

    expect(prompts).toHaveLength(0);
    expect(await backend.read(resolveStoreNamespace(), "MEMORY.md")).toBeNull();
  });
});
