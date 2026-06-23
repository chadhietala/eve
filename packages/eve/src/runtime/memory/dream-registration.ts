import type { CompiledAgentManifest } from "#compiler/manifest.js";

/**
 * Stable Nitro task name for the framework-owned memory dream.
 *
 * Unlike authored schedules (one task per source file), there is exactly one
 * dream task per deployment. The name is fixed (not derived from a path)
 * because the task is framework-owned, not authored.
 */
export const EVE_DREAM_TASK_NAME = "eve.memory.dream";

/**
 * Default cron cadence for the dream when the author declares none. Daily keeps
 * the dream cost low; a run whose window holds no new sessions is a
 * cheap no-op. Authors override it with {@link DreamConfig.cron}.
 */
export const DEFAULT_DREAM_CRON = "0 3 * * *";

/**
 * One framework-owned dream registration consumed by the Nitro host
 * wiring. Mirrors `ScheduleRegistration` but is singular (one per deployment)
 * and carries no authored source identity.
 */
export interface DreamRegistration {
  readonly cron: string;
  readonly description: string;
  readonly taskName: string;
}

/**
 * Reports whether any agent node in the compiled graph declares a memory
 * `dream`.
 *
 * Walks the root agent and every subagent. A node opts into dream by
 * declaring a `dream` on its memory definition (the static config rides the
 * manifest; only its presence matters here). Apps with no dream anywhere never
 * register the backstop, so non-memory deployments pay nothing.
 */
export function manifestHasDream(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.memory?.dream !== undefined);
}

/**
 * Builds the dream registration for a compiled graph, or `undefined`
 * when no agent declares a dream.
 *
 * The single returned registration drives one Nitro scheduled task on the root
 * agent's {@link DreamConfig.cron} cadence (or {@link DEFAULT_DREAM_CRON} when
 * none is declared). The keying is per-deployment: the task runs the root
 * agent's dream, which folds each of its `rw` stores. Memory writes are
 * versioned and content-addressed, so even a redundant run over the same
 * transcripts is idempotent.
 */
export function createDreamRegistration(
  manifest: CompiledAgentManifest,
): DreamRegistration | undefined {
  if (!manifestHasDream(manifest)) {
    return undefined;
  }

  return {
    cron: manifest.memory?.dream?.cron ?? DEFAULT_DREAM_CRON,
    description: "Run agents' memory dream (the dream).",
    taskName: EVE_DREAM_TASK_NAME,
  };
}
