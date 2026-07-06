import { describe, expect, it } from "vitest";

import { ObjectConflictError } from "#runtime/memory/object-store.js";
import {
  type FetchLike,
  vercelBlobMemoryStore,
  VercelBlobObjectStore,
} from "#runtime/memory/vercel-blob-object-store.js";

const API = "https://blob.vercel-storage.com";
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

interface StoredBlob {
  bytes: Uint8Array;
  etag: string;
  uploadedAt: string;
}

/**
 * A fake Blob REST transport modelling the conditional-write contract: quoted
 * ETags, `x-allow-overwrite: 0` failing on an existing key (409), and
 * `x-if-match` failing on a stale ETag (412).
 */
function fakeBlob(): { fetch: FetchLike; store: Map<string, StoredBlob> } {
  const store = new Map<string, StoredBlob>();
  let seq = 0;
  const urlFor = (pathname: string) => `https://s.private.blob.vercel-storage.com/${pathname}`;
  const pathnameOf = (url: string) => url.split("/").slice(3).join("/");

  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (method === "PUT") {
      const pathname = url.slice(API.length + 1);
      const existing = store.get(pathname);
      if (headers["x-allow-overwrite"] === "0" && existing !== undefined) {
        return new Response(null, { status: 409 });
      }
      const ifMatch = headers["x-if-match"];
      if (ifMatch !== undefined && existing?.etag !== ifMatch) {
        return new Response(null, { status: 412 });
      }
      const etag = `"v${++seq}"`;
      store.set(pathname, {
        bytes: new Uint8Array(init!.body as ArrayBuffer),
        etag,
        uploadedAt: new Date(seq * 1000).toISOString(),
      });
      return new Response(JSON.stringify({ url: urlFor(pathname), pathname }), {
        status: 200,
        headers: { etag, "content-type": "application/json" },
      });
    }

    if (method === "POST" && url === `${API}/delete`) {
      const { urls } = JSON.parse(init!.body as string) as { urls: string[] };
      for (const u of urls) {
        store.delete(pathnameOf(u));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }

    // GET: a prefix listing (has `?prefix=`) or a blob-url fetch.
    const parsed = new URL(url);
    if (parsed.searchParams.has("prefix")) {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const blobs = [...store.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, b]) => ({
          pathname: p,
          url: urlFor(p),
          size: b.bytes.byteLength,
          uploadedAt: b.uploadedAt,
          etag: b.etag,
        }));
      return new Response(JSON.stringify({ blobs, hasMore: false }), { status: 200 });
    }
    const object = store.get(pathnameOf(url));
    return object === undefined
      ? new Response(null, { status: 404 })
      : new Response(object.bytes, { status: 200 });
  };

  return { fetch, store };
}

function make(): VercelBlobObjectStore {
  return new VercelBlobObjectStore({ fetch: fakeBlob().fetch, token: "t" });
}

describe("VercelBlobObjectStore", () => {
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
    await expect(store.put("a.md", bytes("v3"), v1)).rejects.toBeInstanceOf(ObjectConflictError);
    expect(await store.head("a.md")).toBe(v2);
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

  it("vercelBlobMemoryStore is a durable MemoryStore over the blob store", async () => {
    const memory = vercelBlobMemoryStore({ fetch: fakeBlob().fetch });
    await memory.write("facts.md", bytes("v1"), "k");
    await memory.write("facts.md", bytes("v2"), "k", {
      expectedVersion: await memory.head("facts.md"),
    });
    expect(text(await memory.read("facts.md"))).toBe("v2");
    // Content changes recorded immutable version snapshots.
    expect((await memory.listVersions("facts.md")).length).toBe(2);
  });
});
