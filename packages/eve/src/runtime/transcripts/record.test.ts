import { describe, expect, test } from "vitest";

import { recordSessionTurns } from "#runtime/transcripts/record.js";
import { InMemoryTranscriptStore } from "#runtime/transcripts/store.js";

describe("recordSessionTurns", () => {
  test("appends every turn on a fresh session", async () => {
    const store = new InMemoryTranscriptStore();
    const appended = await recordSessionTurns(store, "s1", [{ n: 1 }, { n: 2 }]);
    expect(appended).toBe(2);
    expect(await store.read("s1")).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("appends only the new suffix as history grows across steps", async () => {
    const store = new InMemoryTranscriptStore();
    await recordSessionTurns(store, "s1", [{ n: 1 }]);
    const appended = await recordSessionTurns(store, "s1", [{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(appended).toBe(2);
    expect(await store.read("s1")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("re-recording the same history is a no-op (replay-safe)", async () => {
    const store = new InMemoryTranscriptStore();
    const history = [{ n: 1 }, { n: 2 }];
    await recordSessionTurns(store, "s1", history);
    const appended = await recordSessionTurns(store, "s1", history);
    expect(appended).toBe(0);
    expect(await store.read("s1")).toEqual(history);
  });
});
