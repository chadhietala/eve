import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { conditionalObjectMemoryStore } from "#runtime/memory/conditional-object-store.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryObjectStore } from "#runtime/memory/object-store.js";
import { memoryList, memoryRead, memoryWrite } from "#execution/sandbox/memory-redirect.js";

const ROOT = "/mnt/memory";

/** Mounts a single object-store-backed `notes` store and runs `fn` under it. */
async function withObjectStore<T>(fn: (object: InMemoryObjectStore) => Promise<T>): Promise<T> {
  const object = new InMemoryObjectStore();
  const store: MountedStore = {
    name: "notes",
    backend: conditionalObjectMemoryStore(object),
    mountPath: `${ROOT}/notes`,
    access: "rw",
  };
  const config: MemoryConfig = { root: ROOT, stores: [store] };
  const ctx = new ContextContainer();
  ctx.set(MemoryConfigKey, config);
  return contextStorage.run(ctx, () => fn(object));
}

describe("file-tool redirect over a conditional object store", () => {
  it("routes write/read through the object-store backend", async () => {
    await withObjectStore(async (object) => {
      await memoryWrite("/mnt/memory/notes/facts.md", "Priya owns the deploy token.");
      expect(await memoryRead("/mnt/memory/notes/facts.md")).toBe("Priya owns the deploy token.");
      // The bytes land in the underlying object store at the store-relative key.
      const stored = await object.get("facts.md");
      expect(stored).not.toBeNull();
      expect(new TextDecoder().decode(stored!.bytes)).toBe("Priya owns the deploy token.");
    });
  });

  it("overwrites in place via the redirect's head-based compare-and-swap", async () => {
    await withObjectStore(async (object) => {
      await memoryWrite("/mnt/memory/notes/f.md", "first");
      await memoryWrite("/mnt/memory/notes/f.md", "second");
      expect(await memoryRead("/mnt/memory/notes/f.md")).toBe("second");
      // Each content change recorded an immutable version sidecar in the store.
      const sidecars = (await object.list("f.md.versions/")).length;
      expect(sidecars).toBe(2);
    });
  });

  it("lists mount-prefixed paths without leaking version sidecars", async () => {
    await withObjectStore(async () => {
      await memoryWrite("/mnt/memory/notes/a.md", "a");
      await memoryWrite("/mnt/memory/notes/a.md", "aa"); // creates a sidecar
      await memoryWrite("/mnt/memory/notes/b.md", "b");
      const listed = await memoryList("/mnt/memory/notes");
      expect(listed.sort()).toEqual(["/mnt/memory/notes/a.md", "/mnt/memory/notes/b.md"]);
    });
  });
});
