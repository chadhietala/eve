import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { maybeDumpSession } from "#context/session-dump-step.js";
import type { HarnessSession } from "#harness/types.js";
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const MOUNTED_NAMESPACE: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "agent-1",
  scopeType: "working",
};

const SESSIONS_NAMESPACE: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "agent-1",
  scopeType: "sessions",
};

function makeConfig(store: InMemoryMemoryStore): MemoryConfig {
  return {
    namespace: MOUNTED_NAMESPACE,
    sessionsNamespace: SESSIONS_NAMESPACE,
    root: "/memory",
    store,
  };
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
  it("writes the transcript to the off-mount sessions namespace, not the mounted one", async () => {
    const store = new InMemoryMemoryStore();
    const session = makeSession([{ role: "user", content: "hi" }]);

    await withMemory(makeConfig(store), (ctx) => maybeDumpSession(ctx, session));

    const stored = decode(
      await store.read(SESSIONS_NAMESPACE, "sessions/session-42/transcript.jsonl"),
    );
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ role: "user", content: "hi" });

    // The mounted memory area (what /memory serves) must stay untouched.
    expect(await store.list(MOUNTED_NAMESPACE, "")).toEqual([]);
  });

  it("is a no-op when no MemoryConfig is present", async () => {
    const store = new InMemoryMemoryStore();
    const session = makeSession([{ role: "user", content: "hi" }]);

    await withMemory(undefined, (ctx) => maybeDumpSession(ctx, session));

    expect(await store.list(SESSIONS_NAMESPACE, "")).toEqual([]);
  });
});
