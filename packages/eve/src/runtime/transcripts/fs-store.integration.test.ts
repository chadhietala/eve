import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsTranscriptStore } from "#runtime/transcripts/fs-store.js";

describe("FsTranscriptStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "eve-transcripts-"));
  });

  afterEach(async () => {
    await rm(baseDir, { force: true, recursive: true });
  });

  it("appends turns and reads them back in order", async () => {
    const store = new FsTranscriptStore(baseDir);
    await store.append("s1", { role: "user", text: "hi" });
    await store.append("s1", { role: "assistant", text: "hello" });

    expect(await store.read("s1")).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
  });

  it("persists across store instances over the same dir", async () => {
    await new FsTranscriptStore(baseDir).append("s1", { n: 1 });
    expect(await new FsTranscriptStore(baseDir).read("s1")).toEqual([{ n: 1 }]);
  });

  it("read of an unknown session is null", async () => {
    expect(await new FsTranscriptStore(baseDir).read("missing")).toBeNull();
  });

  it("derives createdAt/updatedAt/turns from the embedded line timestamps", async () => {
    let clock = 100;
    const store = new FsTranscriptStore(baseDir, () => clock);
    await store.append("s1", { n: 1 });
    clock = 250;
    await store.append("s1", { n: 2 });

    const [info] = await store.list();
    expect(info).toEqual({ sessionId: "s1", createdAt: 100, updatedAt: 250, turns: 2 });
  });

  it("lists newest-first and filters by window", async () => {
    let clock = 0;
    const store = new FsTranscriptStore(baseDir, () => clock);
    clock = 50;
    await store.append("a", { n: 1 });
    clock = 150;
    await store.append("b", { n: 1 });
    clock = 250;
    await store.append("c", { n: 1 });

    expect((await store.list()).map((i) => i.sessionId)).toEqual(["c", "b", "a"]);
    expect((await store.list({ since: 100, until: 200 })).map((i) => i.sessionId)).toEqual(["b"]);
  });

  it("prune deletes transcripts older than the cutoff", async () => {
    let clock = 0;
    const store = new FsTranscriptStore(baseDir, () => clock);
    clock = 100;
    await store.append("old", { n: 1 });
    clock = 500;
    await store.append("fresh", { n: 1 });

    expect(await store.prune(300)).toEqual({ removed: 1 });
    expect((await store.list()).map((i) => i.sessionId)).toEqual(["fresh"]);
    expect(await store.read("old")).toBeNull();
  });

  it("list on a never-created dir is empty, not an error", async () => {
    const store = new FsTranscriptStore(join(baseDir, "nope"));
    expect(await store.list()).toEqual([]);
  });

  it("rejects an unsafe session id", async () => {
    const store = new FsTranscriptStore(baseDir);
    await expect(store.append("a/b", {})).rejects.toThrow(/Invalid transcript session id/);
  });
});
