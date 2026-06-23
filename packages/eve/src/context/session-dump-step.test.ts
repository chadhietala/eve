import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { maybeDumpSession } from "#context/session-dump-step.js";
import type { HarnessSession } from "#harness/types.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { InMemoryTranscriptStore } from "#runtime/transcripts/store.js";

const ROOT = "/mnt/memory";

function mountStore(name: string, access: "ro" | "rw"): MountedStore {
  return { name, backend: new InMemoryMemoryStore(), mountPath: `${ROOT}/${name}`, access };
}

function makeConfig(transcriptStore?: InMemoryTranscriptStore): MemoryConfig {
  const config: MemoryConfig = { root: ROOT, stores: [mountStore("notes", "rw")] };
  return transcriptStore === undefined ? config : { ...config, dream: {}, transcriptStore };
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

describe("maybeDumpSession", () => {
  it("records the session's turns into the session-level transcript log", async () => {
    const transcripts = new InMemoryTranscriptStore();
    const session = makeSession([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    await withMemory(makeConfig(transcripts), (ctx) => maybeDumpSession(ctx, session));

    expect(await transcripts.read("session-42")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("appends only new turns across repeated dumps within a session", async () => {
    const transcripts = new InMemoryTranscriptStore();
    const config = makeConfig(transcripts);

    await withMemory(config, (ctx) =>
      maybeDumpSession(ctx, makeSession([{ role: "user", content: "hi" }])),
    );
    await withMemory(config, (ctx) =>
      maybeDumpSession(
        ctx,
        makeSession([
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ]),
      ),
    );

    const turns = await transcripts.read("session-42");
    expect(turns).toHaveLength(2);
  });

  it("is a no-op when the agent has no transcript log (no dream)", async () => {
    await withMemory(makeConfig(), (ctx) =>
      maybeDumpSession(ctx, makeSession([{ role: "user", content: "hi" }])),
    );
    // Reaching here without throwing is the assertion: no transcript store to write to.
    expect(true).toBe(true);
  });

  it("is a no-op when no MemoryConfig is present", async () => {
    await withMemory(undefined, (ctx) =>
      maybeDumpSession(ctx, makeSession([{ role: "user", content: "hi" }])),
    );
    expect(true).toBe(true);
  });
});
