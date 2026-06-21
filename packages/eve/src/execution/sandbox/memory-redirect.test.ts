import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import { resolveStoreNamespace, resolveTranscriptsNamespace } from "#runtime/memory/namespace.js";
import {
  memoryGrep,
  memoryList,
  memoryRead,
  memoryWrite,
  shouldRedirectToMemory,
} from "#execution/sandbox/memory-redirect.js";

const ROOT = "/mnt/memory";

function mountStore(overrides: Partial<MountedStore> & { name: string }): MountedStore {
  return {
    backend: new InMemoryMemoryStore(),
    mountPath: `${ROOT}/${overrides.name}`,
    access: "rw",
    ...overrides,
  };
}

function makeConfig(stores: readonly MountedStore[]): MemoryConfig {
  return { root: ROOT, stores };
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
      expect(shouldRedirectToMemory("/mnt/memory/notes/x.md")).toBe(false);
    });
  });

  it("matches the root exactly and paths beneath it", async () => {
    await withMemory(makeConfig([mountStore({ name: "notes" })]), async () => {
      expect(shouldRedirectToMemory("/mnt/memory")).toBe(true);
      expect(shouldRedirectToMemory("/mnt/memory/notes/x.md")).toBe(true);
    });
  });

  it("does not match sibling paths that merely share a prefix", async () => {
    await withMemory(makeConfig([mountStore({ name: "notes" })]), async () => {
      expect(shouldRedirectToMemory("/mnt/memory-other/x.md")).toBe(false);
    });
  });
});

describe("routing to the right store", () => {
  it("routes a write/read under a store's mount to that store's backend + curated namespace", async () => {
    const store = mountStore({ name: "notes" });
    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "hello");
      expect(await memoryRead("/mnt/memory/notes/a.md")).toBe("hello");
    });

    // The bytes land in the curated namespace at the store-relative path.
    const curated = resolveStoreNamespace("notes");
    const bytes = await store.backend.read(curated, "a.md");
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("hello");
  });

  it("isolates two stores: a write to one is not visible through the other", async () => {
    const notes = mountStore({ name: "notes" });
    const facts = mountStore({ name: "facts" });
    await withMemory(makeConfig([notes, facts]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "in-notes");
      expect(await memoryRead("/mnt/memory/facts/a.md")).toBeNull();
      expect(await memoryRead("/mnt/memory/notes/a.md")).toBe("in-notes");
    });
  });

  it("lets the longest-prefix mount win when one mount nests under another", async () => {
    // `inner` mounts at /mnt/memory/notes/inner; `notes` at /mnt/memory/notes.
    const notes = mountStore({ name: "notes", mountPath: `${ROOT}/notes` });
    const inner = mountStore({ name: "inner", mountPath: `${ROOT}/notes/inner` });
    await withMemory(makeConfig([notes, inner]), async () => {
      await memoryWrite("/mnt/memory/notes/inner/a.md", "deep");
      // Resolves to `inner`, store-relative path "a.md".
      expect(await memoryRead("/mnt/memory/notes/inner/a.md")).toBe("deep");
    });

    expect(await inner.backend.read(resolveStoreNamespace("inner"), "a.md")).not.toBeNull();
    expect(await notes.backend.read(resolveStoreNamespace("notes"), "inner/a.md")).toBeNull();
  });
});

describe("access enforcement", () => {
  it("rejects a write to a read-only store with a clear error", async () => {
    const store = mountStore({ name: "facts", access: "ro" });
    await withMemory(makeConfig([store]), async () => {
      await expect(memoryWrite("/mnt/memory/facts/a.md", "x")).rejects.toThrow(/read-only/);
    });
    // Nothing was written.
    expect(await store.backend.read(resolveStoreNamespace("facts"), "a.md")).toBeNull();
  });

  it("still allows reads from a read-only store", async () => {
    const store = mountStore({ name: "facts", access: "ro" });
    await store.backend.write(
      resolveStoreNamespace("facts"),
      "a.md",
      new TextEncoder().encode("seeded"),
      "k1",
    );
    await withMemory(makeConfig([store]), async () => {
      expect(await memoryRead("/mnt/memory/facts/a.md")).toBe("seeded");
    });
  });
});

describe("unmatched paths", () => {
  it("treats a path under the root matching no store as not-found", async () => {
    await withMemory(makeConfig([mountStore({ name: "notes" })]), async () => {
      expect(await memoryRead("/mnt/memory/unknown/a.md")).toBeNull();
      expect(await memoryList("/mnt/memory/unknown")).toEqual([]);
      await expect(memoryWrite("/mnt/memory/unknown/a.md", "x")).rejects.toThrow(
        /No memory store is mounted/,
      );
    });
  });
});

describe("transcripts are unreachable through the mount", () => {
  it("does not surface transcripts written off-mount via the curated read path", async () => {
    const store = mountStore({ name: "notes" });
    // Write a transcript into the off-mount transcripts namespace directly.
    await store.backend.write(
      resolveTranscriptsNamespace("notes"),
      "transcripts/s1.jsonl",
      new TextEncoder().encode("{}"),
      "k1",
    );
    await withMemory(makeConfig([store]), async () => {
      // The mount serves only the curated namespace — the transcript is invisible.
      expect(await memoryRead("/mnt/memory/notes/transcripts/s1.jsonl")).toBeNull();
      expect(await memoryList("/mnt/memory/notes")).toEqual([]);
    });
  });
});

describe("memoryList / memoryGrep", () => {
  it("returns full mount-prefixed paths from the matching store", async () => {
    const store = mountStore({ name: "notes" });
    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "a");
      await memoryWrite("/mnt/memory/notes/sub/b.md", "b");
      const listed = await memoryList("/mnt/memory/notes");
      expect(listed.sort()).toEqual(["/mnt/memory/notes/a.md", "/mnt/memory/notes/sub/b.md"]);
    });
  });

  it("greps within the matching store with full paths and 1-based line numbers", async () => {
    const store = mountStore({ name: "notes" });
    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/n.md", "alpha\nbeta needle\ngamma");
      const hits = await memoryGrep({
        ignoreCase: false,
        limit: 100,
        literal: false,
        pattern: "needle",
        prefix: "/mnt/memory/notes",
      });
      expect(hits).toEqual([
        { line: "beta needle", lineNumber: 2, path: "/mnt/memory/notes/n.md" },
      ]);
    });
  });
});
