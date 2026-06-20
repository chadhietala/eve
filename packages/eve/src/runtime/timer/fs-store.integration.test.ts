import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FsTimerStore } from "#runtime/timer/fs-store.js";
import type { TimerTaskRef } from "#runtime/timer/types.js";

const task: TimerTaskRef = { name: "reply", payload: { thread: "t1" } };

describe("FsTimerStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "eve-fs-timer-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("roundtrips arm and get", async () => {
    const store = new FsTimerStore(baseDir);
    await store.arm({ key: "slack:c1:t1", dueAt: 1000, task });

    expect(await store.get("slack:c1:t1")).toEqual({
      key: "slack:c1:t1",
      dueAt: 1000,
      task,
      status: "armed",
    });
  });

  it("returns null for an absent key", async () => {
    const store = new FsTimerStore(baseDir);
    expect(await store.get("missing")).toBeNull();
  });

  it("persists arm/claim across store instances so a claim never fires twice", async () => {
    const first = new FsTimerStore(baseDir);
    await first.arm({ key: "k1", dueAt: 1000, task });

    // A fresh instance against the same baseDir simulates a process restart.
    const second = new FsTimerStore(baseDir);
    const claimed = await second.claimDue(1500, 10);
    expect(claimed.map((r) => r.key)).toEqual(["k1"]);
    expect(claimed[0]?.status).toBe("fired");

    // The fired transition persisted: a third instance claims nothing.
    const third = new FsTimerStore(baseDir);
    expect(await third.claimDue(1500, 10)).toEqual([]);
    expect((await third.get("k1"))?.status).toBe("fired");
  });

  it("persists a cancellation across store instances", async () => {
    const first = new FsTimerStore(baseDir);
    await first.arm({ key: "k1", dueAt: 1000, task });
    await first.cancel("k1");

    const second = new FsTimerStore(baseDir);
    expect((await second.get("k1"))?.status).toBe("cancelled");
    expect(await second.claimDue(2000, 10)).toEqual([]);
  });
});
