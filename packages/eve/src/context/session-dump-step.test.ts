import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { maybeDumpSession } from "#context/session-dump-step.js";
import type { HarnessSession } from "#harness/types.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";

const ROOT = "/mnt/memory";

function mountStore(
  name: string,
  access: "ro" | "rw",
  backend = new InMemoryMemoryStore(),
): MountedStore {
  return { name, backend, mountPath: `${ROOT}/${name}`, access };
}

function makeConfig(stores: readonly MountedStore[]): MemoryConfig {
  return { root: ROOT, stores };
}

function makeSession(history: ModelMessage[]): HarnessSession {
  return {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 0, threshold: 0 },
    continuationToken: "",
    history,
    sessionId: "session-42",
  };
}

async function withMemory<T>(
  config: MemoryConfig | undefined,
  fn: (ctx: ContextContainer) => Promise<T>,
): Promise<T> {
  const ctx = new ContextContainer();
  if (config !== undefined) {
    ctx.set(MemoryConfigKey, config);
  }
  return contextStorage.run(ctx, () => fn(ctx)) as Promise<T>;
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

describe("maybeDumpSession", () => {
  it("dumps the transcript to transcripts/<id>.jsonl in each rw store's transcripts namespace", async () => {
    const notes = mountStore("notes", "rw");
    const facts = mountStore("facts", "rw");
    const session = makeSession([{ role: "user", content: "hi" }]);

    await withMemory(makeConfig([notes, facts]), (ctx) => maybeDumpSession(ctx, session));

    for (const store of [notes, facts]) {
      const ns = resolveTranscriptsNamespace();
      const stored = decode(await store.backend.read(ns, "transcripts/session-42.jsonl"));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual({ role: "user", content: "hi" });

      // Never in the curated (mounted) namespace.
      expect(await store.backend.list(resolveStoreNamespace(), "")).toEqual([]);
    }
  });

  it("does not dump into a read-only store", async () => {
    const rw = mountStore("notes", "rw");
    const ro = mountStore("facts", "ro");
    const session = makeSession([{ role: "user", content: "hi" }]);

    await withMemory(makeConfig([rw, ro]), (ctx) => maybeDumpSession(ctx, session));

    expect(await ro.backend.list(resolveTranscriptsNamespace(), "")).toEqual([]);
    expect(
      await rw.backend.read(resolveTranscriptsNamespace(), "transcripts/session-42.jsonl"),
    ).not.toBeNull();
  });

  it("is a no-op when no MemoryConfig is present", async () => {
    const store = new InMemoryMemoryStore();
    const session = makeSession([{ role: "user", content: "hi" }]);

    await withMemory(undefined, (ctx) => maybeDumpSession(ctx, session));

    expect(await store.list(resolveTranscriptsNamespace(), "")).toEqual([]);
  });
});
