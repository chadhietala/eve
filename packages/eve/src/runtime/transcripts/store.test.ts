import { describe, expect, test } from "vitest";

import {
  assertSafeSessionId,
  InMemoryTranscriptStore,
  withinWindow,
} from "#runtime/transcripts/store.js";

describe("assertSafeSessionId", () => {
  test("accepts a plain id", () => {
    expect(() => assertSafeSessionId("sesn_01")).not.toThrow();
  });

  test.each(["", "a/b", "a\\b", "../escape"])("rejects %o", (id) => {
    expect(() => assertSafeSessionId(id)).toThrow(/Invalid transcript session id/);
  });
});

describe("withinWindow", () => {
  test("no window matches everything", () => {
    expect(withinWindow(0)).toBe(true);
    expect(withinWindow(1_000_000)).toBe(true);
  });

  test("half-open [since, until)", () => {
    const window = { since: 100, until: 200 };
    expect(withinWindow(99, window)).toBe(false);
    expect(withinWindow(100, window)).toBe(true);
    expect(withinWindow(199, window)).toBe(true);
    expect(withinWindow(200, window)).toBe(false);
  });

  test("open-ended bounds", () => {
    expect(withinWindow(50, { since: 100 })).toBe(false);
    expect(withinWindow(150, { since: 100 })).toBe(true);
    expect(withinWindow(150, { until: 100 })).toBe(false);
    expect(withinWindow(50, { until: 100 })).toBe(true);
  });
});

describe("InMemoryTranscriptStore", () => {
  test("append creates then accumulates turns in order", async () => {
    const store = new InMemoryTranscriptStore();
    await store.append("s1", { role: "user", text: "hi" });
    await store.append("s1", { role: "assistant", text: "hello" });

    expect(await store.read("s1")).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  test("read of an unknown session is null", async () => {
    const store = new InMemoryTranscriptStore();
    expect(await store.read("missing")).toBeNull();
  });

  test("read returns a copy — mutating it does not affect the store", async () => {
    const store = new InMemoryTranscriptStore();
    await store.append("s1", { n: 1 });
    const turns = (await store.read("s1")) as unknown[];
    turns.push({ n: 2 });
    expect(await store.read("s1")).toEqual([{ n: 1 }]);
  });

  test("createdAt is first append, updatedAt is latest append", async () => {
    let clock = 100;
    const store = new InMemoryTranscriptStore(() => clock);
    await store.append("s1", { n: 1 });
    clock = 250;
    await store.append("s1", { n: 2 });

    const [info] = await store.list();
    expect(info).toEqual({ sessionId: "s1", createdAt: 100, updatedAt: 250, turns: 2 });
  });

  test("list is newest-first by updatedAt", async () => {
    let clock = 0;
    const store = new InMemoryTranscriptStore(() => clock);
    clock = 100;
    await store.append("old", { n: 1 });
    clock = 300;
    await store.append("new", { n: 1 });
    clock = 200;
    await store.append("mid", { n: 1 });

    expect((await store.list()).map((i) => i.sessionId)).toEqual(["new", "mid", "old"]);
  });

  test("list filters by window on updatedAt", async () => {
    let clock = 0;
    const store = new InMemoryTranscriptStore(() => clock);
    clock = 50;
    await store.append("a", { n: 1 });
    clock = 150;
    await store.append("b", { n: 1 });
    clock = 250;
    await store.append("c", { n: 1 });

    const ids = (await store.list({ since: 100, until: 200 })).map((i) => i.sessionId);
    expect(ids).toEqual(["b"]);
  });

  test("prune removes transcripts older than the cutoff and reports the count", async () => {
    let clock = 0;
    const store = new InMemoryTranscriptStore(() => clock);
    clock = 100;
    await store.append("old", { n: 1 });
    clock = 500;
    await store.append("fresh", { n: 1 });

    expect(await store.prune(300)).toEqual({ removed: 1 });
    expect((await store.list()).map((i) => i.sessionId)).toEqual(["fresh"]);
    expect(await store.read("old")).toBeNull();
  });

  test("append rejects an unsafe session id", async () => {
    const store = new InMemoryTranscriptStore();
    await expect(store.append("a/b", {})).rejects.toThrow(/Invalid transcript session id/);
  });
});
