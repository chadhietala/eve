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
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import { dumpSession, formatTranscriptJsonl } from "#runtime/memory/session-dump.js";
import { buildWriteKey } from "#runtime/memory/write-key.js";

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

describe("memory lifecycle: dump → dream → recall (multi-store)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eve-mem-lifecycle-"));
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("consolidates dumped transcripts into a store's MEMORY.md and recalls it per store", async () => {
    const backend = new FsMemoryStore(dir);
    const curatedNs = resolveStoreNamespace();
    const transcriptsNs = resolveTranscriptsNamespace();

    // 1) A session's transcript is dumped off-mount into the store's transcripts.
    const transcript = [
      { role: "user" as const, content: "My deploy token rotates every 14 days; Priya owns it." },
      { role: "assistant" as const, content: "Got it." },
    ];
    const raw = formatTranscriptJsonl(transcript);
    await dumpSession(backend, transcriptsNs, {
      sessionId: "s1",
      messages: transcript,
      writeKey: buildWriteKey({ namespace: transcriptsNs, turnId: "s1", seq: 0, content: raw }),
    });

    const store: MountedStore = {
      name: STORE,
      backend,
      mountPath: `${ROOT}/${STORE}`,
      access: "rw",
    };
    const config: MemoryConfig = { root: ROOT, stores: [store], dream: {} };

    // 2) The dream consolidates the transcripts into the store's curated memory.
    const CONSOLIDATED = "# Memory\n\n- Priya owns the deploy token rotation (every 14 days).";
    await runDream(config, { model: mockModel(CONSOLIDATED) });

    // The consolidated memory landed in the curated namespace...
    expect(decode(await backend.read(curatedNs, "MEMORY.md"))).toBe(CONSOLIDATED);
    // ...and the raw transcript is byte-for-byte untouched (the safe property).
    expect(decode(await backend.read(transcriptsNs, "transcripts/s1.jsonl"))).toBe(raw);

    // 3) A later turn: recall surfaces the consolidated memory in the prompt,
    // labeled by store (mirrors what seedMemoryConfig reads + orientation injects).
    const index = `## ${STORE}\n\n${decode(await backend.read(curatedNs, "MEMORY.md"))}`;
    const ctx = new ContextContainer();
    ctx.set(MemoryConfigKey, { ...config, memoryIndex: index });
    const orientation = buildMemoryOrientationMessages(ctx)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    expect(orientation).toContain("Your consolidated memory");
    expect(orientation).toContain(`## ${STORE}`);
    expect(orientation).toContain("Priya owns the deploy token rotation");
  });
});
