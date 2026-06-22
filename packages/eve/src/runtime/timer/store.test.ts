import { describe, expect, it } from "vitest";
import { InMemoryTimerStore } from "#runtime/timer/store.js";
import type { TimerTaskRef } from "#runtime/timer/types.js";

const task: TimerTaskRef = { name: "reply", payload: { thread: "t1" } };

describe("InMemoryTimerStore", () => {
  it("arms an armed record with the given dueAt and task", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });

    const record = await store.get("k1");
    expect(record).toEqual({ key: "k1", dueAt: 1000, task, status: "armed" });
  });

  it("re-arms an existing key: updates dueAt/task, keeps one record, resets to armed", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });
    // Fire it so it leaves the armed state.
    await store.claimDue(1000, 10);
    expect((await store.get("k1"))?.status).toBe("fired");

    const nextTask: TimerTaskRef = { name: "reply", payload: { thread: "t2" } };
    await store.arm({ key: "k1", dueAt: 5000, task: nextTask });

    const record = await store.get("k1");
    expect(record).toEqual({ key: "k1", dueAt: 5000, task: nextTask, status: "armed" });
  });

  it("cancel marks the record cancelled and claimDue skips it", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });
    await store.cancel("k1");

    expect((await store.get("k1"))?.status).toBe("cancelled");
    expect(await store.claimDue(2000, 10)).toEqual([]);
  });

  it("cancel is a no-op for an absent key", async () => {
    const store = new InMemoryTimerStore();
    await store.cancel("missing");
    expect(await store.get("missing")).toBeNull();
  });

  it("claimDue returns due armed records, marks them fired, and never returns them twice", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });

    const first = await store.claimDue(1500, 10);
    expect(first.map((r) => r.key)).toEqual(["k1"]);
    expect(first[0]?.status).toBe("fired");

    // Exactly-once: a second claim returns nothing.
    expect(await store.claimDue(1500, 10)).toEqual([]);
  });

  it("claimDue skips not-yet-due records", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });

    expect(await store.claimDue(999, 10)).toEqual([]);
    expect((await store.get("k1"))?.status).toBe("armed");
  });

  it("claimDue respects the limit", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "a", dueAt: 100, task });
    await store.arm({ key: "b", dueAt: 100, task });
    await store.arm({ key: "c", dueAt: 100, task });

    const claimed = await store.claimDue(200, 2);
    expect(claimed).toHaveLength(2);

    // The remaining due record is still claimable.
    expect(await store.claimDue(200, 10)).toHaveLength(1);
  });

  it("get returns the record or null", async () => {
    const store = new InMemoryTimerStore();
    await store.arm({ key: "k1", dueAt: 1000, task });
    expect((await store.get("k1"))?.key).toBe("k1");
    expect(await store.get("nope")).toBeNull();
  });
});
