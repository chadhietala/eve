import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

const NS: MemoryNamespace = {
  agentId: "agent-a",
  scopeId: "slack:C123:T456",
  scopeType: "working",
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
});
