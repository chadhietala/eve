import { describe, expect, it } from "vitest";

import { ConditionalObjectMemoryStore } from "#runtime/memory/conditional-object-store.js";
import { InMemoryObjectStore } from "#runtime/memory/object-store.js";
import { MemoryConflictError } from "#runtime/memory/store.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);
const KEY = "k";

function make(now?: () => string): ConditionalObjectMemoryStore {
  return new ConditionalObjectMemoryStore(new InMemoryObjectStore(now));
}

describe("ConditionalObjectMemoryStore", () => {
  it("reads back what it writes", async () => {
    const store = make();
    await store.write("notes.md", bytes("hi"), KEY);
    expect(text(await store.read("notes.md"))).toBe("hi");
  });

  it("head returns the current version, null when absent", async () => {
    const store = make();
    expect(await store.head("notes.md")).toBeNull();
    await store.write("notes.md", bytes("hi"), KEY);
    const version = await store.head("notes.md");
    expect(version).not.toBeNull();
  });

  it("compare-and-swap: succeeds on the current head, throws on a stale one", async () => {
    const store = make();
    await store.write("notes.md", bytes("v1"), KEY);
    const head = await store.head("notes.md");
    await store.write("notes.md", bytes("v2"), KEY, { expectedVersion: head });
    expect(text(await store.read("notes.md"))).toBe("v2");

    // `head` is now stale.
    await expect(
      store.write("notes.md", bytes("v3"), KEY, { expectedVersion: head }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
    expect(text(await store.read("notes.md"))).toBe("v2");
  });

  it("expectedVersion null creates only when absent", async () => {
    const store = make();
    await store.write("fresh.md", bytes("hi"), KEY, { expectedVersion: null });
    expect(text(await store.read("fresh.md"))).toBe("hi");
    await expect(
      store.write("fresh.md", bytes("clobber"), KEY, { expectedVersion: null }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it("records a version per content change; identical content adds none", async () => {
    let t = 0;
    const store = make(() => `2026-07-06T00:00:0${t++}.000Z`);
    await store.write("notes.md", bytes("v1"), KEY);
    await store.write("notes.md", bytes("v2"), KEY);
    await store.write("notes.md", bytes("v2"), KEY); // identical → no new version

    const versions = await store.listVersions("notes.md");
    expect(versions.length).toBe(2);
    // Newest first.
    expect(text(await store.readVersion("notes.md", versions[0]!.version))).toBe("v2");
    expect(text(await store.readVersion("notes.md", versions[1]!.version))).toBe("v1");
  });

  it("readVersion returns null for an unknown version", async () => {
    const store = make();
    await store.write("notes.md", bytes("x"), KEY);
    expect(await store.readVersion("notes.md", "nope")).toBeNull();
  });

  it("restore = read an old version and write it back", async () => {
    let t = 0;
    const store = make(() => `2026-07-06T00:00:0${t++}.000Z`);
    await store.write("notes.md", bytes("v1"), KEY);
    await store.write("notes.md", bytes("v2"), KEY);
    const versions = await store.listVersions("notes.md");
    const old = await store.readVersion("notes.md", versions[1]!.version);
    await store.write("notes.md", old as Uint8Array, KEY);
    expect(text(await store.read("notes.md"))).toBe("v1");
  });

  it("list excludes version sidecars", async () => {
    const store = make(() => "2026-07-06T00:00:00.000Z");
    await store.write("a.md", bytes("a"), KEY);
    await store.write("a.md", bytes("aa"), KEY); // creates a version sidecar
    await store.write("b.md", bytes("b"), KEY);

    const entries = await store.list("");
    expect(entries.map((e) => e.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("removes a path (leaving its version history)", async () => {
    const store = make();
    await store.write("gone.md", bytes("x"), KEY);
    await store.remove("gone.md", KEY);
    expect(await store.read("gone.md")).toBeNull();
  });

  it("is multi-writer safe over a shared object store (loser conflicts, retry lands both)", async () => {
    // Two MemoryStores over ONE object store model two hosts on the same bucket.
    const object = new InMemoryObjectStore();
    const a = new ConditionalObjectMemoryStore(object);
    const b = new ConditionalObjectMemoryStore(object);

    await a.write("shared.md", bytes("from A"), KEY, { expectedVersion: null });

    // B read the head as absent and races a create — the atomic precondition rejects it.
    await expect(
      b.write("shared.md", bytes("from B"), KEY, { expectedVersion: null }),
    ).rejects.toBeInstanceOf(MemoryConflictError);

    // Conflict-aware retry: B re-reads the head and writes under it.
    await b.write("shared.md", bytes("from B"), KEY, {
      expectedVersion: await b.head("shared.md"),
    });
    expect(text(await a.read("shared.md"))).toBe("from B");
    // A's revision survives in the shared version trail — no lost write.
    expect((await a.listVersions("shared.md")).length).toBe(2);
  });
});
