import type { LanguageModel } from "ai";

import { runDream } from "#runtime/memory/dream.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";
import { sweepDueTimers } from "#runtime/timer/timer.js";
import type { TimerStore } from "#runtime/timer/store.js";
import type { TimerRecord } from "#runtime/timer/types.js";

/**
 * Durable task name carried on a consolidation timer's {@link TimerTaskRef}.
 *
 * The sweep selects consolidate timers by matching `task.name` against this
 * constant, so the same registry can hold unrelated timers without the
 * consolidation runner firing them.
 */
export const CONSOLIDATE_TASK_NAME = "eve.memory.consolidate";

/** Prefix for the per-agent consolidation timer key. */
const CONSOLIDATE_KEY_PREFIX = "consolidate:";

/**
 * The durable timer key for an agent's consolidation. One timer per agent, so
 * re-arming on each active step slides the single deadline forward rather than
 * stacking timers.
 */
export function consolidationTimerKey(agentId: string): string {
  return `${CONSOLIDATE_KEY_PREFIX}${agentId}`;
}

/**
 * The payload a consolidation timer carries: the agent whose memory to
 * consolidate. The timer layer treats this as opaque; the runner reads
 * `agentId` back out to load that agent's config.
 */
export interface ConsolidateTaskPayload {
  readonly agentId: string;
}

/** Filename suffix every per-session transcript dump lands at. */
const TRANSCRIPT_FILENAME = "transcript.jsonl";

/**
 * Counts the raw session transcripts available to consolidate for a config.
 *
 * Lists the off-mount sessions namespace under `sessions/` and counts entries
 * ending in `transcript.jsonl` — the same shape {@link runDream} reads. Pure
 * over the injected store, so the `minSessions` gate is testable without a
 * model or timer.
 */
export async function countSessionTranscripts(
  store: MemoryStore,
  sessionsNamespace: MemoryNamespace,
): Promise<number> {
  const entries = await store.list(sessionsNamespace, "sessions/");
  let count = 0;
  for (const entry of entries) {
    if (entry.path.endsWith(`/${TRANSCRIPT_FILENAME}`)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Decides whether a config has enough accumulated sessions to consolidate.
 *
 * `minSessions` is the author's floor below which a dream is not worth running
 * (the curated memory wouldn't change meaningfully). Absent or zero means "no
 * floor" — any session count passes. A separate, pure-ish helper so the gate is
 * unit-tested in isolation from the model and timer plumbing.
 */
export async function meetsMinSessions(config: MemoryConfig, store: MemoryStore): Promise<boolean> {
  const minSessions = config.dream?.schedule?.minSessions;
  if (minSessions === undefined || minSessions <= 0) {
    return true;
  }
  const count = await countSessionTranscripts(store, config.sessionsNamespace);
  return count >= minSessions;
}

/** Inputs for {@link runDueConsolidations}. */
export interface RunDueConsolidationsInput {
  /** The durable timer registry to sweep. */
  readonly timerStore: TimerStore;
  /** Injected wall clock; the sweep selects timers with `dueAt <= now`. */
  readonly now: number;
  /** Max timers to fire in one sweep. Defaults to a small batch. */
  readonly limit?: number;
  /**
   * Loads the live {@link MemoryConfig} for an agent (store, namespaces, dream).
   * Returns `undefined` when the agent no longer exists — that timer is then
   * skipped rather than failing the sweep.
   */
  readonly loadConfig: (agentId: string) => Promise<MemoryConfig | undefined>;
  /** Resolves the {@link LanguageModel} the dream's synthesis calls. */
  readonly resolveModel: (config: MemoryConfig) => Promise<LanguageModel>;
}

/**
 * Fires every due memory-consolidation timer.
 *
 * Sweeps the timer registry (claiming due records exactly once), and for each
 * timer whose task is the consolidate task: reads `agentId` from the payload,
 * loads that agent's {@link MemoryConfig}, gates on `dream.schedule.minSessions`
 * (skipping when too few sessions have accumulated), resolves the model, and
 * runs the dream. Returns how many consolidations actually ran.
 *
 * Every dependency — clock, timer store, config loader, model resolver — is
 * injected, so the orchestration is fully unit-testable with fakes and never
 * reaches a real model, filesystem, or clock. A claimed timer is consumed
 * whether or not its consolidation ran: the gate and "agent gone" cases skip
 * the dream but still spend the timer, and the next active step re-arms a fresh
 * one. `loadConfig`/`resolveModel` failures bubble up (the timer was already
 * claimed, matching the timer layer's at-most-once contract).
 */
export async function runDueConsolidations(
  input: RunDueConsolidationsInput,
): Promise<{ ran: number }> {
  const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
  let ran = 0;

  await sweepDueTimers(input.timerStore, { now: input.now, limit }, async (record) => {
    if (record.task.name !== CONSOLIDATE_TASK_NAME) {
      return;
    }
    const agentId = readAgentId(record);
    if (agentId === undefined) {
      return;
    }
    const config = await input.loadConfig(agentId);
    if (config === undefined) {
      return;
    }
    if (!(await meetsMinSessions(config, config.store))) {
      return;
    }
    const model = await input.resolveModel(config);
    await runDream(config, { model });
    ran += 1;
  });

  return { ran };
}

/** Default batch size for one consolidation sweep. */
const DEFAULT_SWEEP_LIMIT = 16;

/**
 * Recovers the agent id from a consolidation timer's payload. Returns
 * `undefined` for a malformed payload so a stray record is skipped rather than
 * crashing the sweep.
 */
function readAgentId(record: TimerRecord): string | undefined {
  const agentId = record.task.payload?.agentId;
  return typeof agentId === "string" ? agentId : undefined;
}
