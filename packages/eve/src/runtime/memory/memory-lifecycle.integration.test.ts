import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { buildMemoryOrientationMessages } from "#context/memory-orientation.js";
import {
  type BootstrapGenerateOptions,
  createBootstrapGenerateResult,
} from "#runtime/agent/bootstrap-model-utils.js";
import { runDream } from "#runtime/memory/dream.js";
import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { FsTranscriptStore } from "#runtime/transcripts/fs-store.js";
import { recordSessionTurns } from "#runtime/transcripts/record.js";

const ROOT = "/mnt/memory";
const STORE = "notes";
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string {
  expect(bytes).not.toBeNull();
  return decoder.decode(bytes as Uint8Array);
}

function mockModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    modelId: "mock-dream-model",
    provider: "eve-test",
    doGenerate: async (_options: BootstrapGenerateOptions) =>
      createBootstrapGenerateResult({
        inputTokens: 1,
        modelId: "mock-dream-model",
        outputTokens: 1,
        text,
      }),
  });
}

describe("memory lifecycle: record → dream → recall", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eve-mem-lifecycle-"));
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("records a session, folds the window into a file, and recalls it", async () => {
    const backend = new FsMemoryStore(join(dir, "store"));
    const transcriptStore = new FsTranscriptStore(join(dir, "transcripts"));

    // 1) A session's turns are recorded into the session-level transcript log.
    const turns = [
      { role: "user" as const, content: "My deploy token rotates every 14 days; Priya owns it." },
      { role: "assistant" as const, content: "Got it." },
    ];
    await recordSessionTurns(transcriptStore, "s1", turns);

    const store: MountedStore = {
      name: STORE,
      backend,
      mountPath: `${ROOT}/${STORE}`,
      access: "rw",
    };
    // 2) The dream folds the windowed transcripts into curated memory. A
    //    `run` override writes deterministically — this test covers the
    //    record→dream→recall LIFECYCLE, not the dream agent's tool-calling.
    const CURATED = "# Memory\n\n- Priya owns the deploy token rotation (every 14 days).";
    const config: MemoryConfig = {
      root: ROOT,
      stores: [store],
      dream: {
        run: async (dreamCtx) => {
          // The dream sees the recorded session as its windowed input.
          expect(dreamCtx.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
          await dreamCtx.memory.write("notes.md", CURATED);
        },
      },
      transcriptStore,
    };
    await runDream(config, { model: mockModel(CURATED), now: Date.now() });

    expect(decode(await backend.read("notes.md"))).toBe(CURATED);
    // The transcript log (the dream's input) is untouched.
    expect(await transcriptStore.read("s1")).toEqual(turns);

    // 3) A later turn: recall surfaces the curated file in the prompt as a
    //    listing; the agent reads its content on demand.
    const entries = await backend.list("");
    const listing = `## ${STORE}\n\n${entries.map((entry) => `- ${entry.path}`).join("\n")}`;
    const ctx = new ContextContainer();
    ctx.set(MemoryConfigKey, { ...config, memoryListing: listing });
    const orientation = buildMemoryOrientationMessages(ctx)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    expect(orientation).toContain("Your memory contains these files");
    expect(orientation).toContain(`## ${STORE}`);
    expect(orientation).toContain("- notes.md");
  });
});
