import { describe, expect, it } from "vitest";

import { ObjectConflictError } from "#runtime/memory/object-store.js";
import {
  type S3Client,
  s3MemoryStore,
  S3ObjectStore,
  S3PreconditionError,
} from "#runtime/memory/s3-object-store.js";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

/** A fake S3 client modelling ETags and conditional-put preconditions. */
function fakeS3(): S3Client {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; modifiedAt: string }>();
  let seq = 0;
  return {
    async getObject(key) {
      const object = objects.get(key);
      return object === undefined ? null : { bytes: object.bytes, etag: object.etag };
    },
    async headObject(key) {
      return objects.get(key)?.etag ?? null;
    },
    async putObject(key, body, { ifMatch, ifNoneMatch }) {
      const existing = objects.get(key);
      if (ifNoneMatch === "*" && existing !== undefined) {
        throw new S3PreconditionError(existing.etag);
      }
      if (ifMatch !== undefined && existing?.etag !== ifMatch) {
        throw new S3PreconditionError(existing?.etag ?? null);
      }
      const etag = `"v${++seq}"`;
      objects.set(key, { bytes: body, etag, modifiedAt: new Date(seq * 1000).toISOString() });
      return etag;
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async listObjects(prefix) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => ({
          key: k,
          size: o.bytes.byteLength,
          modifiedAt: o.modifiedAt,
          etag: o.etag,
        }));
    },
  };
}

const make = (): S3ObjectStore => new S3ObjectStore(fakeS3());

describe("S3ObjectStore", () => {
  it("puts and gets an object with an ETag version", async () => {
    const store = make();
    const version = await store.put("a.md", bytes("hello"));
    const object = await store.get("a.md");
    expect(text(object?.bytes ?? null)).toBe("hello");
    expect(object?.version).toBe(version);
    expect(await store.head("a.md")).toBe(version);
  });

  it("returns null head/get for an absent key", async () => {
    const store = make();
    expect(await store.head("missing")).toBeNull();
    expect(await store.get("missing")).toBeNull();
  });

  it("create-if-absent (null) conflicts on an existing key", async () => {
    const store = make();
    await store.put("a.md", bytes("first"), null);
    await expect(store.put("a.md", bytes("second"), null)).rejects.toBeInstanceOf(
      ObjectConflictError,
    );
    expect(text((await store.get("a.md"))?.bytes ?? null)).toBe("first");
  });

  it("if-match succeeds on the current ETag and conflicts on a stale one", async () => {
    const store = make();
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
    expect((caught as ObjectConflictError).actual).toBe(v2);
  });

  it("an unconditional put overwrites regardless of version", async () => {
    const store = make();
    await store.put("a.md", bytes("v1"));
    await store.put("a.md", bytes("v2"));
    expect(text((await store.get("a.md"))?.bytes ?? null)).toBe("v2");
  });

  it("lists and deletes under the configured prefix", async () => {
    const store = make();
    await store.put("notes/a.md", bytes("a"));
    await store.put("notes/b.md", bytes("bb"));
    const listed = await store.list("notes/");
    expect(listed.map((i) => i.key).sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(listed.find((i) => i.key === "notes/b.md")?.size).toBe(2);

    await store.delete("notes/a.md");
    expect(await store.get("notes/a.md")).toBeNull();
  });

  it("s3MemoryStore is a durable MemoryStore over the bucket", async () => {
    const memory = s3MemoryStore(fakeS3());
    await memory.write("facts.md", bytes("v1"), "k");
    await memory.write("facts.md", bytes("v2"), "k", {
      expectedVersion: await memory.head("facts.md"),
    });
    expect(text(await memory.read("facts.md"))).toBe("v2");
    expect((await memory.listVersions("facts.md")).length).toBe(2);
  });
});
