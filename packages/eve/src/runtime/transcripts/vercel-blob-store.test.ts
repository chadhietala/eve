import { beforeEach, describe, expect, test } from "vitest";

import {
  type FetchLike,
  VercelBlobTranscriptStore,
} from "#runtime/transcripts/vercel-blob-store.js";

const API = "https://blob.example.test";

/**
 * An in-memory fake of the Vercel Blob REST surface the store calls: PUT a blob,
 * GET `?prefix=` to list, GET a blob url for content, POST `/delete`. Records
 * the auth header it last saw so a test can assert the token is sent.
 */
function createFakeBlob(now: () => number) {
  const blobs = new Map<string, { content: string; uploadedAt: number }>();
  let lastAuth: string | null = null;

  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== undefined) {
      lastAuth = headers.authorization;
    }

    if (method === "PUT") {
      const pathname = url.slice(`${API}/`.length);
      blobs.set(pathname, { content: String(init?.body), uploadedAt: now() });
      return json({ url: `${API}/${pathname}`, pathname });
    }

    if (method === "POST" && url === `${API}/delete`) {
      const { urls } = JSON.parse(String(init?.body)) as { urls: string[] };
      for (const u of urls) {
        blobs.delete(u.slice(`${API}/`.length));
      }
      return json({});
    }

    if (method === "GET" && new URL(url).searchParams.has("prefix")) {
      const prefix = new URL(url).searchParams.get("prefix") ?? "";
      const list = [...blobs.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .map(([pathname, blob]) => ({
          pathname,
          url: `${API}/${pathname}`,
          uploadedAt: new Date(blob.uploadedAt).toISOString(),
        }));
      return json({ blobs: list, hasMore: false });
    }

    // GET a blob's content url.
    const pathname = url.slice(`${API}/`.length);
    const blob = blobs.get(pathname);
    if (blob === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(blob.content, { status: 200 });
  }) satisfies FetchLike;

  return { fakeFetch, blobs, getLastAuth: () => lastAuth };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("VercelBlobTranscriptStore", () => {
  let clock: number;
  let fake: ReturnType<typeof createFakeBlob>;

  function makeStore() {
    return new VercelBlobTranscriptStore({
      apiBase: API,
      token: "vercel_blob_rw_TEST",
      fetch: fake.fakeFetch,
      now: () => clock,
    });
  }

  beforeEach(() => {
    clock = 0;
    fake = createFakeBlob(() => clock);
  });

  test("append then read round-trips turns in order", async () => {
    const store = makeStore();
    clock = 100;
    await store.append("s1", { role: "user", text: "hi" });
    clock = 200;
    await store.append("s1", { role: "assistant", text: "hello" });

    expect(await store.read("s1")).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  test("sends the bearer token", async () => {
    const store = makeStore();
    await store.append("s1", { n: 1 });
    expect(fake.getLastAuth()).toBe("Bearer vercel_blob_rw_TEST");
  });

  test("read of an unknown session is null", async () => {
    expect(await makeStore().read("missing")).toBeNull();
  });

  test("list groups blobs by session, newest-first, with derived times", async () => {
    const store = makeStore();
    clock = 100;
    await store.append("a", { n: 1 });
    clock = 300;
    await store.append("b", { n: 1 });
    clock = 400;
    await store.append("b", { n: 2 });

    const infos = await store.list();
    expect(infos).toEqual([
      { sessionId: "b", createdAt: 300, updatedAt: 400, turns: 2 },
      { sessionId: "a", createdAt: 100, updatedAt: 100, turns: 1 },
    ]);
  });

  test("list filters by window", async () => {
    const store = makeStore();
    clock = 50;
    await store.append("a", { n: 1 });
    clock = 150;
    await store.append("b", { n: 1 });

    expect((await store.list({ since: 100 })).map((i) => i.sessionId)).toEqual(["b"]);
  });

  test("prune deletes sessions older than the cutoff", async () => {
    const store = makeStore();
    clock = 100;
    await store.append("old", { n: 1 });
    clock = 500;
    await store.append("fresh", { n: 1 });

    expect(await store.prune(300)).toEqual({ removed: 1 });
    expect((await store.list()).map((i) => i.sessionId)).toEqual(["fresh"]);
    expect(await store.read("old")).toBeNull();
  });

  test("rejects an unsafe session id before any request", async () => {
    await expect(makeStore().append("a/b", {})).rejects.toThrow(/Invalid transcript session id/);
  });

  test("throws on a non-ok response", async () => {
    const store = new VercelBlobTranscriptStore({
      apiBase: API,
      token: "t",
      fetch: async () => new Response("boom", { status: 500 }),
      now: () => clock,
    });
    await expect(store.append("s1", {})).rejects.toThrow(/status 500/);
  });
});
