import type { CompiledAgentManifest } from "#compiler/manifest.js";

/**
 * Stable Nitro task name for the framework-owned memory-consolidation backstop.
 *
 * Unlike authored schedules (one task per source file), there is exactly one
 * consolidation task per deployment: it sweeps every due per-agent idle timer,
 * so a single cron entry serves all agents. The name is fixed (not derived from
 * a path) because the task is framework-owned, not authored.
 */
export const EVE_CONSOLIDATION_TASK_NAME = "eve.memory.consolidate.sweep";

/**
 * Cron cadence for the consolidation backstop.
 *
 * The durable per-agent idle timers carry the real timing — each active step
 * slides its agent's deadline forward, and consolidation fires once a timer is
 * past due. This cron only *sweeps* for due timers, so a coarse cadence is
 * enough: the responsiveness comes from the timer deadline, not the sweep
 * frequency. Every minute keeps the worst-case latency between "timer due" and
 * "dream runs" under a minute while costing one cheap no-op sweep per minute
 * when nothing is due.
 */
export const EVE_CONSOLIDATION_CRON = "* * * * *";

/**
 * One framework-owned consolidation registration consumed by the Nitro host
 * wiring. Mirrors `ScheduleRegistration` but is singular (one per deployment)
 * and carries no authored source identity.
 */
export interface ConsolidationRegistration {
  readonly cron: string;
  readonly description: string;
  readonly taskName: string;
}

/**
 * Reports whether any agent node in the compiled graph declares a memory
 * `dream`.
 *
 * Walks the root agent and every subagent. A node opts into consolidation by
 * declaring a `dream` on its memory definition (the static config rides the
 * manifest; only its presence matters here). Apps with no dream anywhere never
 * register the backstop, so non-memory deployments pay nothing.
 */
export function manifestHasDream(manifest: CompiledAgentManifest): boolean {
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return nodes.some((node) => node.memory?.dream !== undefined);
}

/**
 * Builds the consolidation registration for a compiled graph, or `undefined`
 * when no agent declares a dream.
 *
 * The single returned registration drives one Nitro scheduled task and one cron
 * entry. The keying is intentionally per-deployment, not per-agent: the task
 * sweeps *all* due per-agent idle timers in one pass, and a store shared by
 * several agents may be consolidated by more than one agent's timer firing.
 * That is safe — memory writes are versioned and content-addressed (CAS), so a
 * redundant dream over the same transcripts is idempotent. This is the design,
 * not a gap: it keeps the cron surface a single fixed entry regardless of how
 * many agents share stores.
 */
export function createConsolidationRegistration(
  manifest: CompiledAgentManifest,
): ConsolidationRegistration | undefined {
  if (!manifestHasDream(manifest)) {
    return undefined;
  }

  return {
    cron: EVE_CONSOLIDATION_CRON,
    description: "Sweep due eve memory-consolidation timers and run agents' dreams.",
    taskName: EVE_CONSOLIDATION_TASK_NAME,
  };
}
