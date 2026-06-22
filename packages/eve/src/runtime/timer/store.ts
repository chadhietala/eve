import type { TimerRecord } from "#runtime/timer/types.js";

/**
 * The eve-owned durable registry of due-time entries that drive timers.
 *
 * A timer is "set a task to run at an absolute deadline, keyed by id, surviving
 * restarts". The registry persists each {@link TimerRecord} and is swept on a
 * cadence (a cron backstop drives the sweep in a later slice). All selection is
 * against a caller-injected `now`, so the logic is deterministic and clock-free.
 *
 * The exactly-once contract lives in {@link TimerStore.claimDue}: claiming a due
 * record transitions it to `"fired"`, and a fired record is never returned
 * again. A single sweeper therefore dispatches each timer's task at most once.
 *
 * Implementations include {@link InMemoryTimerStore} (tests, dev) and a
 * real-filesystem backend behind this same interface.
 */
export interface TimerStore {
  /**
   * Arms a timer, upserting by `key` (PUT semantics).
   *
   * Re-arming an existing `key` replaces its `dueAt` and `task` and resets its
   * status to `"armed"`, even if it had already fired or been cancelled. This
   * is how an idle-race "slides" a timer forward: the latest arm wins.
   */
  arm(record: Pick<TimerRecord, "key" | "dueAt" | "task">): Promise<void>;

  /**
   * Marks the timer with `key` as `"cancelled"`. A no-op if `key` is absent.
   *
   * A cancelled timer is never selected by {@link TimerStore.claimDue} unless a
   * later {@link TimerStore.arm} re-arms it.
   */
  cancel(key: string): Promise<void>;

  /**
   * Atomically claims up to `limit` due timers: selects records that are
   * `"armed"` with `dueAt <= now`, transitions them to `"fired"`, and returns
   * them (with their already-updated `"fired"` status).
   *
   * This is the exactly-once gate. A record returned here is committed as fired
   * before it is handed back, so a subsequent claim — even after a crash and
   * restart between sweeps — never returns it again.
   */
  claimDue(now: number, limit: number): Promise<TimerRecord[]>;

  /**
   * Reads the record for `key`, or `null` if none exists. For introspection and
   * tests; not part of the sweep path.
   */
  get(key: string): Promise<TimerRecord | null>;
}

/**
 * In-memory {@link TimerStore} for tests, dev, and reuse by higher layers.
 *
 * Holds records in a `Map` keyed by `key`. Because a sweep runs as a single
 * `await`-free synchronous pass over the map between awaits, the read-select-mark
 * sequence in {@link InMemoryTimerStore.claimDue} is effectively atomic for the
 * single-sweeper model the registry assumes.
 */
export class InMemoryTimerStore implements TimerStore {
  readonly #records = new Map<string, TimerRecord>();

  async arm(record: Pick<TimerRecord, "key" | "dueAt" | "task">): Promise<void> {
    this.#records.set(record.key, {
      key: record.key,
      dueAt: record.dueAt,
      task: record.task,
      status: "armed",
    });
  }

  async cancel(key: string): Promise<void> {
    const existing = this.#records.get(key);
    if (existing === undefined) {
      return;
    }
    this.#records.set(key, { ...existing, status: "cancelled" });
  }

  async claimDue(now: number, limit: number): Promise<TimerRecord[]> {
    const claimed: TimerRecord[] = [];
    for (const record of this.#records.values()) {
      if (claimed.length >= limit) {
        break;
      }
      if (record.status !== "armed" || record.dueAt > now) {
        continue;
      }
      const fired: TimerRecord = { ...record, status: "fired" };
      this.#records.set(record.key, fired);
      claimed.push(fired);
    }
    return claimed;
  }

  async get(key: string): Promise<TimerRecord | null> {
    return this.#records.get(key) ?? null;
  }
}
