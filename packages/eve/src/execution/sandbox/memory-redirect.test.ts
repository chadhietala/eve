import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { type MemoryConfig, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { resolveMemoryNamespace, resolveSessionsNamespace } from "#runtime/memory/namespace.js";
import {
  memoryGrep,
  memoryList,
  memoryRead,
  memoryWrite,
  shouldRedirectToMemory,
} from "#execution/sandbox/memory-redirect.js";

const NAMESPACE = resolveMemoryNamespace({ agentId: "agent-1" });
const SESSIONS_NAMESPACE = resolveSessionsNamespace({ agentId: "agent-1" });

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    namespace: NAMESPACE,
    sessionsNamespace: SESSIONS_NAMESPACE,
    root: "/memory",
    store: new InMemoryMemoryStore(),
    ...overrides,
  };
}

async function withMemory<T>(config: MemoryConfig | undefined, fn: () => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  if (config !== undefined) {
    ctx.set(MemoryConfigKey, config);
  }
  return contextStorage.run(ctx, fn) as Promise<T>;
}

describe("shouldRedirectToMemory", () => {
  it("returns false when no memory config is present", async () => {
    await withMemory(undefined, async () => {
      expect(shouldRedirectToMemory("/memory/notes.md")).toBe(false);
    });
  });

  it("matches the root exactly and paths beneath it", async () => {
    await withMemory(makeConfig(), async () => {
      expect(shouldRedirectToMemory("/memory")).toBe(true);
      expect(shouldRedirectToMemory("/memory/notes.md")).toBe(true);
      expect(shouldRedirectToMemory("/memory/sub/dir.md")).toBe(true);
    });
  });

  it("does not match sibling paths that merely share a prefix", async () => {
    await withMemory(makeConfig(), async () => {
      expect(shouldRedirectToMemory("/memory-other/x.md")).toBe(false);
      expect(shouldRedirectToMemory("/workspace/file.ts")).toBe(false);
    });
  });
});

describe("memoryRead / memoryWrite", () => {
  it("round-trips an in-place write through the store", async () => {
    const config = makeConfig();
    await withMemory(config, async () => {
      await memoryWrite("/memory/notes.md", "hello world");
      expect(await memoryRead("/memory/notes.md")).toBe("hello world");
    });
  });

  it("overwrites a file in place", async () => {
    await withMemory(makeConfig(), async () => {
      await memoryWrite("/memory/index.md", "v1");
      await memoryWrite("/memory/index.md", "v2");
      expect(await memoryRead("/memory/index.md")).toBe("v2");
    });
  });

  it("returns null for an absent path", async () => {
    await withMemory(makeConfig(), async () => {
      expect(await memoryRead("/memory/missing.md")).toBeNull();
    });
  });

  it("routes through onRead/onWrite handlers when present", async () => {
    const reads: string[] = [];
    const writes: Array<[string, string]> = [];
    const decoder = new TextDecoder();
    const config = makeConfig({
      handlers: {
        onRead: (path) => {
          reads.push(path);
          return new TextEncoder().encode("handler value");
        },
        onWrite: (path, bytes) => {
          writes.push([path, decoder.decode(bytes)]);
        },
      },
    });
    await withMemory(config, async () => {
      await memoryWrite("/memory/a.md", "payload");
      expect(await memoryRead("/memory/a.md")).toBe("handler value");
    });
    expect(reads).toEqual(["a.md"]);
    expect(writes).toEqual([["a.md", "payload"]]);
  });
});

describe("memoryList", () => {
  it("returns full root-prefixed paths", async () => {
    const config = makeConfig();
    await withMemory(config, async () => {
      await memoryWrite("/memory/a.md", "a");
      await memoryWrite("/memory/sub/b.md", "b");
      const listed = await memoryList("/memory");
      expect(listed.sort()).toEqual(["/memory/a.md", "/memory/sub/b.md"]);
    });
  });
});

describe("memoryGrep", () => {
  it("matches lines and reports full paths with 1-based line numbers", async () => {
    const config = makeConfig();
    await withMemory(config, async () => {
      await memoryWrite("/memory/notes.md", "alpha\nbeta needle\ngamma");
      const hits = await memoryGrep({
        ignoreCase: false,
        limit: 100,
        literal: false,
        pattern: "needle",
        prefix: "/memory",
      });
      expect(hits).toEqual([{ line: "beta needle", lineNumber: 2, path: "/memory/notes.md" }]);
    });
  });

  it("treats the pattern literally when literal is set", async () => {
    const config = makeConfig();
    await withMemory(config, async () => {
      await memoryWrite("/memory/notes.md", "a.b\naxb");
      const hits = await memoryGrep({
        ignoreCase: false,
        limit: 100,
        literal: true,
        pattern: "a.b",
        prefix: "/memory",
      });
      expect(hits).toEqual([{ line: "a.b", lineNumber: 1, path: "/memory/notes.md" }]);
    });
  });

  it("respects the limit", async () => {
    const config = makeConfig();
    await withMemory(config, async () => {
      await memoryWrite("/memory/notes.md", "x\nx\nx\nx");
      const hits = await memoryGrep({
        ignoreCase: false,
        limit: 2,
        literal: false,
        pattern: "x",
        prefix: "/memory",
      });
      expect(hits).toHaveLength(2);
    });
  });
});
