import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const ns: MemoryNamespace = {
  agentId: "agent-1",
  scopeId: "slack:c1:t1",
  scopeType: "working",
};

const otherNs: MemoryNamespace = { ...ns, scopeId: "slack:c1:t2" };

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

describe("InMemoryMemoryStore", () => {
  it("reads back what it writes", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("hi"), "k1");
    expect(text(await store.read(ns, "notes.md"))).toBe("hi");
  });

  it("returns null for an absent path", async () => {
    const store = new InMemoryMemoryStore();
    expect(await store.read(ns, "missing.md")).toBeNull();
  });

  it("is idempotent: a repeated write key is a no-op", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("first"), "k1");
    await store.write(ns, "notes.md", bytes("second"), "k1");
    expect(text(await store.read(ns, "notes.md"))).toBe("first");
  });

  it("applies a write under a fresh key", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("first"), "k1");
    await store.write(ns, "notes.md", bytes("second"), "k2");
    expect(text(await store.read(ns, "notes.md"))).toBe("second");
  });

  it("isolates namespaces", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("a"), "k1");
    await store.write(otherNs, "notes.md", bytes("b"), "k2");
    expect(text(await store.read(ns, "notes.md"))).toBe("a");
    expect(text(await store.read(otherNs, "notes.md"))).toBe("b");
  });

  it("lists entries by prefix within a namespace, sorted by path", async () => {
    const store = new InMemoryMemoryStore(() => "2026-06-19T00:00:00.000Z");
    await store.write(ns, "journal/2026-06-19.md", bytes("x"), "k1");
    await store.write(ns, "journal/2026-06-18.md", bytes("yy"), "k2");
    await store.write(ns, "other.md", bytes("z"), "k3");
    await store.write(otherNs, "journal/2026-06-19.md", bytes("q"), "k4");

    const entries = await store.list(ns, "journal/");
    expect(entries).toEqual([
      { modifiedAt: "2026-06-19T00:00:00.000Z", path: "journal/2026-06-18.md", size: 2 },
      { modifiedAt: "2026-06-19T00:00:00.000Z", path: "journal/2026-06-19.md", size: 1 },
    ]);
  });

  it("removes a path under a fresh key", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("hi"), "k1");
    await store.remove(ns, "notes.md", "k2");
    expect(await store.read(ns, "notes.md")).toBeNull();
  });

  it("is idempotent on remove: a repeated key is a no-op", async () => {
    const store = new InMemoryMemoryStore();
    await store.write(ns, "notes.md", bytes("hi"), "k1");
    await store.remove(ns, "notes.md", "k2");
    // Re-write under a fresh key, then replay the remove key -> must not delete.
    await store.write(ns, "notes.md", bytes("again"), "k3");
    await store.remove(ns, "notes.md", "k2");
    expect(text(await store.read(ns, "notes.md"))).toBe("again");
  });

  it("records modifiedAt from the injected clock", async () => {
    let t = 0;
    const store = new InMemoryMemoryStore(() => `2026-06-19T00:00:0${t++}.000Z`);
    await store.write(ns, "a.md", bytes("a"), "k1");
    const [entry] = await store.list(ns, "");
    expect(entry?.modifiedAt).toBe("2026-06-19T00:00:00.000Z");
  });
});
