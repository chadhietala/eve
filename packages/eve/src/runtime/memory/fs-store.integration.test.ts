import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import { MemoryConflictError } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";
import { sha256 } from "#runtime/memory/write-key.js";

const NS: MemoryNamespace = {
  agentId: "agent-a",
  scopeId: "notes",
  scopeType: "store",
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

describe("FsMemoryStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "eve-fs-memory-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("roundtrips a write and read", async () => {
    const store = new FsMemoryStore(baseDir);
    await store.write(NS, "notes/todo.txt", bytes("hello"), "k1");

    expect(decode(await store.read(NS, "notes/todo.txt"))).toBe("hello");
  });

  it("returns null for a missing path", async () => {
    const store = new FsMemoryStore(baseDir);
    expect(await store.read(NS, "missing.txt")).toBeNull();
  });

  it("is idempotent: re-applying a seen key is a no-op even with different bytes", async () => {
    const store = new FsMemoryStore(baseDir);
    await store.write(NS, "doc.txt", bytes("first"), "same-key");
    await store.write(NS, "doc.txt", bytes("second"), "same-key");

    expect(decode(await store.read(NS, "doc.txt"))).toBe("first");
  });

  it("lists entries by prefix, sorted, excluding the ledger", async () => {
    const store = new FsMemoryStore(baseDir);
    await store.write(NS, "a/one.txt", bytes("1"), "k-a1");
    await store.write(NS, "a/two.txt", bytes("22"), "k-a2");
    await store.write(NS, "b/three.txt", bytes("333"), "k-b3");

    const listed = await store.list(NS, "a/");
    expect(listed.map((entry) => entry.path)).toEqual(["a/one.txt", "a/two.txt"]);
    expect(listed[0]?.size).toBe(1);
    expect(listed[1]?.size).toBe(2);
    expect(listed.every((entry) => typeof entry.modifiedAt === "string")).toBe(true);

    const all = await store.list(NS, "");
    expect(all.map((entry) => entry.path)).toEqual(["a/one.txt", "a/two.txt", "b/three.txt"]);
  });

  it("removes a path and is idempotent on the removal key", async () => {
    const store = new FsMemoryStore(baseDir);
    await store.write(NS, "gone.txt", bytes("x"), "w-1");
    await store.remove(NS, "gone.txt", "r-1");
    expect(await store.read(NS, "gone.txt")).toBeNull();

    // Re-writing the same path under the already-seen removal key is a no-op.
    await store.remove(NS, "gone.txt", "r-1");
    expect(await store.read(NS, "gone.txt")).toBeNull();
  });

  it("persists data and the idempotency ledger across store instances", async () => {
    const first = new FsMemoryStore(baseDir);
    await first.write(NS, "durable.txt", bytes("persisted"), "durable-key");

    // A fresh instance against the same baseDir simulates a process restart.
    const second = new FsMemoryStore(baseDir);
    expect(decode(await second.read(NS, "durable.txt"))).toBe("persisted");

    // The ledger survived: re-applying the same key is still a no-op.
    await second.write(NS, "durable.txt", bytes("changed"), "durable-key");
    expect(decode(await second.read(NS, "durable.txt"))).toBe("persisted");
  });

  it("persists version history across instances and excludes sidecars from list", async () => {
    const first = new FsMemoryStore(baseDir);
    await first.write(NS, "doc.txt", bytes("v1"), "k1");
    await first.write(NS, "doc.txt", bytes("v2"), "k2");

    // A fresh instance over the same dir simulates a process restart.
    const second = new FsMemoryStore(baseDir);
    const versions = await second.listVersions(NS, "doc.txt");
    expect(versions.map((v) => v.version)).toEqual([sha256("v2"), sha256("v1")]);
    expect(decode(await second.readVersion(NS, "doc.txt", sha256("v1")))).toBe("v1");
    expect(decode(await second.readVersion(NS, "doc.txt", sha256("v2")))).toBe("v2");

    // The `.versions` sidecar directory is infrastructure, never a logical entry.
    const listed = await second.list(NS, "");
    expect(listed.map((entry) => entry.path)).toEqual(["doc.txt"]);
  });

  it("restore (read old version, write back) works after a restart", async () => {
    const first = new FsMemoryStore(baseDir);
    await first.write(NS, "doc.txt", bytes("v1"), "k1");
    await first.write(NS, "doc.txt", bytes("v2"), "k2");

    const second = new FsMemoryStore(baseDir);
    const old = await second.readVersion(NS, "doc.txt", sha256("v1"));
    expect(old).not.toBeNull();
    await second.write(NS, "doc.txt", old as Uint8Array, "k3");

    expect(decode(await second.read(NS, "doc.txt"))).toBe("v1");
  });

  it("a stale expectedVersion conflicts persistently across an instance boundary", async () => {
    const first = new FsMemoryStore(baseDir);
    await first.write(NS, "doc.txt", bytes("v1"), "k1");
    await first.write(NS, "doc.txt", bytes("v2"), "k2");

    // A fresh instance reads the durable head; a write expecting the old head fails.
    const second = new FsMemoryStore(baseDir);
    let caught: unknown;
    try {
      await second.write(NS, "doc.txt", bytes("v3"), "k3", { expectedVersion: sha256("v1") });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryConflictError);
    expect((caught as MemoryConflictError).actual).toBe(sha256("v2"));
    expect(decode(await second.read(NS, "doc.txt"))).toBe("v2");
  });

  it("a CAS write matching the durable head succeeds after a restart", async () => {
    const first = new FsMemoryStore(baseDir);
    await first.write(NS, "doc.txt", bytes("v1"), "k1");

    const second = new FsMemoryStore(baseDir);
    await second.write(NS, "doc.txt", bytes("v2"), "k2", { expectedVersion: sha256("v1") });
    expect(decode(await second.read(NS, "doc.txt"))).toBe("v2");
  });
});
