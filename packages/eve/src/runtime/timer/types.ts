/**
 * Lifecycle state of a durable timer.
 *
 * - `"armed"`: scheduled and eligible to fire once its `dueAt` is reached.
 * - `"fired"`: claimed by a sweep and handed to its task; a terminal state that
 *   the exactly-once gate never re-selects.
 * - `"cancelled"`: explicitly retired before firing; never selected by a sweep.
 */
export type TimerStatus = "armed" | "fired" | "cancelled";

/**
 * An opaque reference to the durable task to run when a timer expires.
 *
 * The timer layer does not interpret `name` or `payload`; it carries them
 * verbatim to whatever dispatches the task on expiry. Keeping this opaque lets
 * the task-dispatch surface evolve without changing the timer registry.
 */
export interface TimerTaskRef {
  /** Identifier of the durable task to invoke on expiry. */
  readonly name: string;
  /** Optional arguments handed to the task verbatim. */
  readonly payload?: Record<string, unknown>;
}

/**
 * A single durable timer: the registry's persisted unit.
 *
 * Identified by `key`; re-arming an existing `key` replaces `dueAt` and `task`
 * (see {@link TimerStore.arm}). `dueAt` is an absolute epoch-millisecond
 * deadline so that selection is a pure comparison against a caller-injected
 * `now` and never reads a real clock.
 */
export interface TimerRecord {
  /** Stable identity of the timer; the upsert and cancel key. */
  readonly key: string;
  /** Absolute deadline in epoch milliseconds at which the timer becomes due. */
  readonly dueAt: number;
  /** The task to run when the timer fires. */
  readonly task: TimerTaskRef;
  /** Current lifecycle state. */
  readonly status: TimerStatus;
}
