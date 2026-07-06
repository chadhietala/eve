import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryStore, MemoryWriteOptions } from "#runtime/memory/store.js";
import type { WriteKey } from "#runtime/memory/types.js";
import { sha256 } from "#runtime/memory/write-key.js";
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

/**
 * Wraps a real store and, on the first `n` write calls only, mutates the head
 * out from under the redirect *just before* delegating — simulating a racing
 * writer that lands between the redirect's read-of-head and its CAS write. The
 * delegated write then sees a stale `expectedVersion` and conflicts, exercising
 * the redirect's retry loop. Once the injection budget is spent, writes pass
 * straight through.
 */
class RacingWriterStore implements MemoryStore {
  conflictsInjected = 0;
  #remaining: number;
  readonly #inner: InMemoryMemoryStore;
  readonly #racer: () => Uint8Array;
  #key = 0;

  constructor(inner: InMemoryMemoryStore, injectCount: number, racer: () => Uint8Array) {
    this.#inner = inner;
    this.#remaining = injectCount;
    this.#racer = racer;
  }

  read(path: string): Promise<Uint8Array | null> {
    return this.#inner.read(path);
  }

  head(path: string): Promise<string | null> {
    return this.#inner.head(path);
  }

  async write(
    path: string,
    bytes: Uint8Array,
    key: WriteKey,
    options?: MemoryWriteOptions,
  ): Promise<void> {
    if (this.#remaining > 0) {
      this.#remaining -= 1;
      this.conflictsInjected += 1;
      // A concurrent writer moves the head under a fresh key right before we
      // delegate, so the caller's `expectedVersion` is now stale.
      this.#key += 1;
      await this.#inner.write(path, this.#racer(), `racer-${this.#key}`);
    }
    await this.#inner.write(path, bytes, key, options);
  }

  list(prefix: string) {
    return this.#inner.list(prefix);
  }

  remove(path: string, key: WriteKey): Promise<void> {
    return this.#inner.remove(path, key);
  }

  listVersions(path: string) {
    return this.#inner.listVersions(path);
  }

  readVersion(path: string, version: string) {
    return this.#inner.readVersion(path, version);
  }
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
  it("routes a write/read under a store's mount to that store's backend", async () => {
    const store = mountStore({ name: "notes" });
    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "hello");
      expect(await memoryRead("/mnt/memory/notes/a.md")).toBe("hello");
    });

    // The bytes land in the backend at the store-relative path.
    const bytes = await store.backend.read("a.md");
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

    expect(await inner.backend.read("a.md")).not.toBeNull();
    expect(await notes.backend.read("inner/a.md")).toBeNull();
  });
});

describe("access enforcement", () => {
  it("rejects a write to a read-only store with a clear error", async () => {
    const store = mountStore({ name: "facts", access: "ro" });
    await withMemory(makeConfig([store]), async () => {
      await expect(memoryWrite("/mnt/memory/facts/a.md", "x")).rejects.toThrow(/read-only/);
    });
    // Nothing was written.
    expect(await store.backend.read("a.md")).toBeNull();
  });

  it("still allows reads from a read-only store", async () => {
    const store = mountStore({ name: "facts", access: "ro" });
    await store.backend.write("a.md", new TextEncoder().encode("seeded"), "k1");
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

describe("transparent compare-and-swap on write", () => {
  it("versions a normal write", async () => {
    const store = mountStore({ name: "notes" });
    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "hello");
    });
    const versions = await store.backend.listVersions("a.md");
    expect(versions.map((v) => v.version)).toEqual([sha256("hello")]);
  });

  it("retries after a concurrent change and ultimately writes; both writes are in history", async () => {
    const inner = new InMemoryMemoryStore();
    // Inject exactly one racing write of "concurrent" before the redirect's CAS.
    const racing = new RacingWriterStore(inner, 1, () => new TextEncoder().encode("concurrent"));
    const store = mountStore({ name: "notes", backend: racing });

    await withMemory(makeConfig([store]), async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "model-output");
    });

    expect(racing.conflictsInjected).toBe(1);
    // The model's content won the head (conflict-aware last-write-wins).
    expect(new TextDecoder().decode((await racing.read("a.md")) as Uint8Array)).toBe(
      "model-output",
    );
    // Both the racing write and the model write survive in the version trail.
    const versions = await racing.listVersions("a.md");
    expect(versions.map((v) => v.version)).toEqual([sha256("model-output"), sha256("concurrent")]);
  });

  it("surfaces a clear error when CAS retries are exhausted", async () => {
    const inner = new InMemoryMemoryStore();
    // A racer that conflicts on every attempt (more than the retry budget).
    let n = 0;
    const racing = new RacingWriterStore(inner, 10, () => new TextEncoder().encode(`race-${n++}`));
    const store = mountStore({ name: "notes", backend: racing });

    await withMemory(makeConfig([store]), async () => {
      await expect(memoryWrite("/mnt/memory/notes/a.md", "model-output")).rejects.toThrow(
        /conflict/i,
      );
    });
    expect(racing.conflictsInjected).toBe(3);
  });

  it("a ro store still rejects before any CAS read/write", async () => {
    const store = mountStore({ name: "facts", access: "ro" });
    await withMemory(makeConfig([store]), async () => {
      await expect(memoryWrite("/mnt/memory/facts/a.md", "x")).rejects.toThrow(/read-only/);
    });
    expect(await store.backend.listVersions("a.md")).toEqual([]);
  });
});
