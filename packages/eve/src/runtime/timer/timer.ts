import type { TimerStore } from "#runtime/timer/store.js";
import type { TimerRecord, TimerTaskRef } from "#runtime/timer/types.js";

/**
 * Arms a timer to fire `afterMs` after `now`.
 *
 * Computes the absolute deadline as `now + afterMs` so the registry stays
 * clock-free — `now` is the only time source and it is injected. Re-calling with
 * the same `key` slides the timer to the new deadline and re-arms it, even if it
 * had already fired or been cancelled (see {@link TimerStore.arm}).
 */
export async function armTimer(
  store: TimerStore,
  input: { key: string; afterMs: number; now: number; task: TimerTaskRef },
): Promise<void> {
  await store.arm({
    key: input.key,
    dueAt: input.now + input.afterMs,
    task: input.task,
  });
}

/**
 * Cancels the timer with `key`, marking it cancelled so no sweep fires it. A
 * no-op if the key is unknown.
 */
export async function cancelTimer(store: TimerStore, key: string): Promise<void> {
  await store.cancel(key);
}

/**
 * Claims and fires every timer due at `now`, up to `limit`, and returns the
 * count fired.
 *
 * Records are claimed first (transitioned to `"fired"` exactly once via
 * {@link TimerStore.claimDue}) and only then handed to `fire`. Because the
 * exactly-once gate commits before dispatch, a `fire` that throws does not
 * un-fire its record — that timer is consumed and will not re-fire on a later
 * sweep. To keep one failing task from starving the rest of the batch, `fire` is
 * invoked per record and a throw aborts only the remaining timers in this sweep;
 * already-fired records are counted in the returned total. A still-due timer is
 * therefore re-armed by the caller, not retried implicitly here.
 */
export async function sweepDueTimers(
  store: TimerStore,
  input: { now: number; limit: number },
  fire: (record: TimerRecord) => Promise<void>,
): Promise<number> {
  const due = await store.claimDue(input.now, input.limit);
  let fired = 0;
  for (const record of due) {
    await fire(record);
    fired += 1;
  }
  return fired;
}
