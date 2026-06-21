import type { ContextContainer } from "#context/container.js";
import { CONSOLIDATE_TASK_NAME, consolidationTimerKey } from "#runtime/memory/consolidate-task.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import { FsTimerStore } from "#runtime/timer/fs-store.js";
import type { TimerStore } from "#runtime/timer/store.js";
import { armTimer } from "#runtime/timer/timer.js";

/**
 * The durable timer store the real (non-test) arm path writes to. A
 * module-level default so the runtime can call {@link maybeArmConsolidation}
 * with just `(ctx, now)`; tests inject an in-memory store instead.
 */
const defaultTimerStore: TimerStore = new FsTimerStore();

/**
 * (Re)arms the agent's memory-consolidation timer at a step's commit when the
 * agent declares `dream.schedule.idleMs`; otherwise a no-op.
 *
 * This is the seam the runtime calls next to {@link maybeDumpSession}. Arming
 * uses {@link armTimer}, which upserts by key — so each active step *slides* the
 * single per-agent timer forward to `now + idleMs`. The deadline therefore only
 * fires once the user has been idle for `idleMs`, and a burst of activity keeps
 * pushing it out rather than consolidating mid-conversation.
 *
 * No-op cases (kept cheap so non-memory and non-idle agents pay nothing):
 *   - no {@link MemoryConfig} seeded (non-memory agent),
 *   - no `dream` declared,
 *   - no `dream.schedule.idleMs` (the agent consolidates on cron only, if at all).
 *
 * The {@link TimerStore} and `now` are injected: the default store is the
 * durable {@link FsTimerStore}; tests pass an `InMemoryTimerStore` and a fixed
 * clock so the armed record is asserted deterministically.
 */
export async function maybeArmConsolidation(
  ctx: ContextContainer,
  now: number,
  timerStore: TimerStore = defaultTimerStore,
): Promise<void> {
  const config = ctx.get(MemoryConfigKey);
  if (config === undefined) {
    return;
  }

  const idleMs = config.dream?.schedule?.idleMs;
  if (idleMs === undefined) {
    return;
  }

  const agentId = config.namespace.agentId;
  await armTimer(timerStore, {
    key: consolidationTimerKey(agentId),
    afterMs: idleMs,
    now,
    task: { name: CONSOLIDATE_TASK_NAME, payload: { agentId } },
  });
}
