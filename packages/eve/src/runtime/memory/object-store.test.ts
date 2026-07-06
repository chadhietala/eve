import { describe, expect, it } from "vitest";

import { InMemoryObjectStore, ObjectConflictError } from "#runtime/memory/object-store.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

describe("InMemoryObjectStore", () => {
  it("puts and gets an object with a head version", async () => {
    const store = new InMemoryObjectStore();
    const version = await store.put("a.md", bytes("hello"));
    const object = await store.get("a.md");
    expect(text(object?.bytes ?? null)).toBe("hello");
    expect(object?.version).toBe(version);
    expect(await store.head("a.md")).toBe(version);
  });

  it("returns null head/get for an absent key", async () => {
    const store = new InMemoryObjectStore();
    expect(await store.head("missing")).toBeNull();
    expect(await store.get("missing")).toBeNull();
  });

  it("create-if-absent (null) succeeds on an absent key, conflicts on an existing one", async () => {
    const store = new InMemoryObjectStore();
    await store.put("a.md", bytes("first"), null);
    await expect(store.put("a.md", bytes("second"), null)).rejects.toBeInstanceOf(
      ObjectConflictError,
    );
    expect(text((await store.get("a.md"))?.bytes ?? null)).toBe("first");
  });

  it("if-match succeeds on the current version and conflicts on a stale one", async () => {
    const store = new InMemoryObjectStore();
    const v1 = await store.put("a.md", bytes("v1"));
    const v2 = await store.put("a.md", bytes("v2"), v1);
    expect(text((await store.get("a.md"))?.bytes ?? null)).toBe("v2");

    let caught: unknown;
    try {
      await store.put("a.md", bytes("v3"), v1); // stale
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ObjectConflictError);
    expect((caught as ObjectConflictError).expected).toBe(v1);
    expect((caught as ObjectConflictError).actual).toBe(v2);
  });

  it("an unconditional put overwrites regardless of the current version", async () => {
    const store = new InMemoryObjectStore();
    await store.put("a.md", bytes("v1"));
    await store.put("a.md", bytes("v2")); // no precondition
    expect(text((await store.get("a.md"))?.bytes ?? null)).toBe("v2");
  });

  it("lists objects by prefix, sorted by key", async () => {
    const store = new InMemoryObjectStore(() => "2026-07-06T00:00:00.000Z");
    await store.put("notes/a.md", bytes("a"));
    await store.put("notes/b.md", bytes("bb"));
    await store.put("other.md", bytes("o"));

    const listed = await store.list("notes/");
    expect(listed.map((i) => i.key)).toEqual(["notes/a.md", "notes/b.md"]);
    expect(listed[0]?.size).toBe(1);
    expect(listed[1]?.size).toBe(2);
    expect(listed[0]?.modifiedAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("deletes an object", async () => {
    const store = new InMemoryObjectStore();
    await store.put("gone", bytes("x"));
    await store.delete("gone");
    expect(await store.get("gone")).toBeNull();
  });
});
