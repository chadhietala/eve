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
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";
import { resolveMemoryNamespace, resolveSessionsNamespace } from "#runtime/memory/namespace.js";
import { dumpSession, formatTranscriptJsonl } from "#runtime/memory/session-dump.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

const AGENT_ID = "lifecycle-agent";
const decoder = new TextDecoder();

function decode(bytes: Uint8Array | null): string {
  expect(bytes).not.toBeNull();
  return decoder.decode(bytes as Uint8Array);
}

/** A mock model that returns a fixed consolidation, standing in for a real one. */
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

describe("memory lifecycle: dump → dream → recall", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eve-mem-lifecycle-"));
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("consolidates dumped sessions into MEMORY.md and recalls it on a later turn", async () => {
    const store = new FsMemoryStore(dir);
    const memoryNs = resolveMemoryNamespace({ agentId: AGENT_ID });
    const sessionsNs = resolveSessionsNamespace({ agentId: AGENT_ID });

    // 1) A session's transcript is dumped off-mount — the raw source of truth.
    const transcript = [
      { role: "user" as const, content: "My deploy token rotates every 14 days; Priya owns it." },
      { role: "assistant" as const, content: "Got it." },
    ];
    const raw = formatTranscriptJsonl(transcript);
    await dumpSession(store, sessionsNs, {
      sessionId: "s1",
      messages: transcript,
      writeKey: buildWriteKey({ namespace: sessionsNs, turnId: "s1", seq: 0, content: raw }),
    });

    const config: MemoryConfig = {
      root: "/memory",
      store,
      namespace: memoryNs,
      sessionsNamespace: sessionsNs,
      dream: {}, // builtin default consolidation
    };

    // 2) The dream consolidates the raw sessions into the mounted memory.
    const CONSOLIDATED = "# Memory\n\n- Priya owns the deploy token rotation (every 14 days).";
    await runDream(config, { model: mockModel(CONSOLIDATED) });

    // The consolidated memory landed on the mount...
    expect(decode(await store.read(memoryNs, "MEMORY.md"))).toBe(CONSOLIDATED);
    // ...and the raw session is byte-for-byte untouched (the safe property).
    expect(decode(await store.read(sessionsNs, "sessions/s1/transcript.jsonl"))).toBe(raw);

    // 3) A later turn: recall surfaces the consolidated memory in the prompt.
    // (mirrors what seedMemoryConfig reads + memory-orientation injects)
    const index = decode(await store.read(memoryNs, "MEMORY.md"));
    const ctx = new ContextContainer();
    ctx.set(MemoryConfigKey, { ...config, memoryIndex: index });
    const orientation = buildMemoryOrientationMessages(ctx)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    expect(orientation).toContain("Your consolidated memory");
    expect(orientation).toContain("Priya owns the deploy token rotation");
  });
});
