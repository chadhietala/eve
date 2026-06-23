import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore, MemoryConflictError } from "#runtime/memory/store.js";
import { sha256 } from "#runtime/memory/write-key.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

describe("InMemoryMemoryStore", () => {
  it("reads back what it writes", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("hi"), "k1");
    expect(text(await store.read("notes.md"))).toBe("hi");
  });

  it("returns null for an absent path", async () => {
    const store = new InMemoryMemoryStore();
    expect(await store.read("missing.md")).toBeNull();
  });

  it("is idempotent: a repeated write key is a no-op", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("first"), "k1");
    await store.write("notes.md", bytes("second"), "k1");
    expect(text(await store.read("notes.md"))).toBe("first");
  });

  it("applies a write under a fresh key", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("first"), "k1");
    await store.write("notes.md", bytes("second"), "k2");
    expect(text(await store.read("notes.md"))).toBe("second");
  });

  it("isolates separate store instances", async () => {
    const a = new InMemoryMemoryStore();
    const b = new InMemoryMemoryStore();
    await a.write("notes.md", bytes("a"), "k1");
    await b.write("notes.md", bytes("b"), "k2");
    expect(text(await a.read("notes.md"))).toBe("a");
    expect(text(await b.read("notes.md"))).toBe("b");
  });

  it("lists entries by prefix, sorted by path", async () => {
    const store = new InMemoryMemoryStore(() => "2026-06-19T00:00:00.000Z");
    await store.write("journal/2026-06-19.md", bytes("x"), "k1");
    await store.write("journal/2026-06-18.md", bytes("yy"), "k2");
    await store.write("other.md", bytes("z"), "k3");

    const entries = await store.list("journal/");
    expect(entries).toEqual([
      { modifiedAt: "2026-06-19T00:00:00.000Z", path: "journal/2026-06-18.md", size: 2 },
      { modifiedAt: "2026-06-19T00:00:00.000Z", path: "journal/2026-06-19.md", size: 1 },
    ]);
  });

  it("removes a path under a fresh key", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("hi"), "k1");
    await store.remove("notes.md", "k2");
    expect(await store.read("notes.md")).toBeNull();
  });

  it("is idempotent on remove: a repeated key is a no-op", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("hi"), "k1");
    await store.remove("notes.md", "k2");
    // Re-write under a fresh key, then replay the remove key -> must not delete.
    await store.write("notes.md", bytes("again"), "k3");
    await store.remove("notes.md", "k2");
    expect(text(await store.read("notes.md"))).toBe("again");
  });

  it("records modifiedAt from the injected clock", async () => {
    let t = 0;
    const store = new InMemoryMemoryStore(() => `2026-06-19T00:00:0${t++}.000Z`);
    await store.write("a.md", bytes("a"), "k1");
    const [entry] = await store.list("");
    expect(entry?.modifiedAt).toBe("2026-06-19T00:00:00.000Z");
  });
});

describe("InMemoryMemoryStore versioning", () => {
  it("records a version on a write and another on a content change, newest-first", async () => {
    let t = 0;
    const store = new InMemoryMemoryStore(() => `2026-06-19T00:00:0${t++}.000Z`);
    await store.write("notes.md", bytes("v1"), "k1");
    await store.write("notes.md", bytes("v2"), "k2");

    const versions = await store.listVersions("notes.md");
    expect(versions.map((v) => v.version)).toEqual([sha256("v2"), sha256("v1")]);
    expect(versions[0]?.modifiedAt).toBe("2026-06-19T00:00:01.000Z");
    expect(versions[1]?.modifiedAt).toBe("2026-06-19T00:00:00.000Z");
  });

  it("returns no versions for an absent path", async () => {
    const store = new InMemoryMemoryStore();
    expect(await store.listVersions("missing.md")).toEqual([]);
  });

  it("readVersion returns the bytes of an old version", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("old"), "k1");
    await store.write("notes.md", bytes("new"), "k2");

    expect(text(await store.readVersion("notes.md", sha256("old")))).toBe("old");
    expect(text(await store.read("notes.md"))).toBe("new");
  });

  it("readVersion returns null for an unknown version", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("x"), "k1");
    expect(await store.readVersion("notes.md", sha256("nope"))).toBeNull();
  });

  it("restore = read an old version and write it back, recording a fresh head version", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("v1"), "k1");
    await store.write("notes.md", bytes("v2"), "k2");

    const restored = await store.readVersion("notes.md", sha256("v1"));
    expect(restored).not.toBeNull();
    await store.write("notes.md", restored as Uint8Array, "k3");

    expect(text(await store.read("notes.md"))).toBe("v1");
    // The restore is itself a version event: head moved v1 -> v2 -> v1.
    const versions = await store.listVersions("notes.md");
    expect(versions.map((v) => v.version)).toEqual([sha256("v1"), sha256("v2"), sha256("v1")]);
  });

  it("an idempotent same-key re-write records no new version", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("first"), "k1");
    await store.write("notes.md", bytes("second"), "k1");

    const versions = await store.listVersions("notes.md");
    expect(versions.map((v) => v.version)).toEqual([sha256("first")]);
  });

  it("writing identical content under a fresh key records no new version", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("same"), "k1");
    await store.write("notes.md", bytes("same"), "k2");

    expect((await store.listVersions("notes.md")).length).toBe(1);
  });
});

describe("InMemoryMemoryStore compare-and-swap", () => {
  it("succeeds when expectedVersion matches the head", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("v1"), "k1");
    await store.write("notes.md", bytes("v2"), "k2", { expectedVersion: sha256("v1") });
    expect(text(await store.read("notes.md"))).toBe("v2");
  });

  it("throws MemoryConflictError on a stale expectedVersion, carrying expected/actual", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("v1"), "k1");
    await store.write("notes.md", bytes("v2"), "k2");

    const stale = sha256("v1");
    let caught: unknown;
    try {
      await store.write("notes.md", bytes("v3"), "k3", { expectedVersion: stale });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryConflictError);
    const conflict = caught as MemoryConflictError;
    expect(conflict.path).toBe("notes.md");
    expect(conflict.expected).toBe(stale);
    expect(conflict.actual).toBe(sha256("v2"));
    // The conflicting write did not land and did not version.
    expect(text(await store.read("notes.md"))).toBe("v2");
  });

  it("expectedVersion null succeeds on an absent path", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("fresh.md", bytes("hi"), "k1", { expectedVersion: null });
    expect(text(await store.read("fresh.md"))).toBe("hi");
  });

  it("expectedVersion null conflicts on an existing path", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("here"), "k1");
    await expect(
      store.write("notes.md", bytes("clobber"), "k2", { expectedVersion: null }),
    ).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it("a CAS conflict does not consume the write key, so a retry can still apply", async () => {
    const store = new InMemoryMemoryStore();
    await store.write("notes.md", bytes("head"), "k1");

    await expect(
      store.write("notes.md", bytes("v3"), "kRetry", { expectedVersion: sha256("stale") }),
    ).rejects.toBeInstanceOf(MemoryConflictError);

    // Same key, now with the correct expectation, must apply.
    await store.write("notes.md", bytes("v3"), "kRetry", { expectedVersion: sha256("head") });
    expect(text(await store.read("notes.md"))).toBe("v3");
  });
});
