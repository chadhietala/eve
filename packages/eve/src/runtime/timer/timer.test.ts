import { describe, expect, it } from "vitest";
import { InMemoryTimerStore } from "#runtime/timer/store.js";
import { armTimer, cancelTimer, sweepDueTimers } from "#runtime/timer/timer.js";
import type { TimerRecord, TimerTaskRef } from "#runtime/timer/types.js";

const task: TimerTaskRef = { name: "reply" };

describe("armTimer", () => {
  it("computes dueAt as now + afterMs", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "k1", afterMs: 500, now: 1000, task });

    const record = await store.get("k1");
    expect(record).toEqual({ key: "k1", dueAt: 1500, task, status: "armed" });
  });

  it("slides the due time when re-armed for the same key", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "k1", afterMs: 500, now: 1000, task });
    await armTimer(store, { key: "k1", afterMs: 500, now: 4000, task });

    expect((await store.get("k1"))?.dueAt).toBe(4500);
  });
});

describe("cancelTimer", () => {
  it("cancels the timer", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "k1", afterMs: 500, now: 1000, task });
    await cancelTimer(store, "k1");

    expect((await store.get("k1"))?.status).toBe("cancelled");
  });
});

describe("sweepDueTimers", () => {
  it("fires each due record once and returns the count", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "a", afterMs: 0, now: 1000, task });
    await armTimer(store, { key: "b", afterMs: 0, now: 1000, task });

    const fired: string[] = [];
    const fire = async (record: TimerRecord): Promise<void> => {
      fired.push(record.key);
    };

    const count = await sweepDueTimers(store, { now: 1000, limit: 10 }, fire);
    expect(count).toBe(2);
    expect(fired.sort()).toEqual(["a", "b"]);
  });

  it("does not fire not-yet-due records", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "a", afterMs: 1000, now: 1000, task });

    const fired: string[] = [];
    const count = await sweepDueTimers(store, { now: 1000, limit: 10 }, async (r) => {
      fired.push(r.key);
    });

    expect(count).toBe(0);
    expect(fired).toEqual([]);
    expect((await store.get("a"))?.status).toBe("armed");
  });

  it("does not re-fire an already-fired timer on a later sweep", async () => {
    const store = new InMemoryTimerStore();
    await armTimer(store, { key: "a", afterMs: 0, now: 1000, task });

    const fire = async (): Promise<void> => {};
    expect(await sweepDueTimers(store, { now: 1000, limit: 10 }, fire)).toBe(1);
    expect(await sweepDueTimers(store, { now: 2000, limit: 10 }, fire)).toBe(0);
  });
});
