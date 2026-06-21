/**
 * Memory-layer context keys.
 *
 * {@link MemoryConfigKey} carries the resolved per-turn memory configuration —
 * a live {@link MemoryStore} instance, the computed namespace, the mount root,
 * and the orientation. Because it holds a live
 * (non-serializable) store, the key is intentionally **codec-less**: it is a
 * transient value re-seeded each turn from the compiled memory definition, and
 * is never persisted at a step boundary. The compiled definition (durable) is
 * the source of truth; this is its hydrated, request-scoped projection.
 */

import { ContextKey } from "#context/key.js";
import type { DreamContext } from "#public/definitions/memory.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { MemoryNamespace } from "#runtime/memory/types.js";

/**
 * The resolved memory configuration for the active turn, seeded into context
 * during bootstrap and read by the redirected file tools at execute time.
 */
export interface MemoryConfig {
  /** Absolute POSIX mount root the file tools redirect under, e.g. `/memory`. */
  readonly root: string;

  /** The backing store for this turn's memory operations. */
  readonly store: MemoryStore;

  /**
   * The namespace the mounted memory is partitioned under: the agent-scoped,
   * persistent area served at {@link MemoryConfig.root} by the file-tool
   * redirect. This is the curated memory the agent reads and writes.
   */
  readonly namespace: MemoryNamespace;

  /**
   * The off-mount raw-sessions namespace: the agent-scoped, immutable area
   * where per-session transcript dumps land. It is the source material a
   * consolidation reads and is deliberately *not* reachable through the mount
   * (a distinct `scopeType` from {@link MemoryConfig.namespace}).
   */
  readonly sessionsNamespace: MemoryNamespace;

  /**
   * Orientation text (the `memory.md` body or `memory.ts` return) injected as a
   * system pointer so the model knows it has a memory filesystem and how to use
   * it. Guidance, not a file under the mount.
   */
  readonly orientation?: string;

  /**
   * The consolidated memory index (`MEMORY.md`) read from the mounted namespace
   * at seed time, injected into the system prompt so the agent's curated memory
   * is in context from turn one (it can still grep/read the rest on demand).
   * Absent until a consolidation has written one.
   */
  readonly memoryIndex?: string;

  /**
   * Memory consolidation ("dream") configuration: the static fields the author
   * declared plus, for a module-backed memory, the live `run` override resolved
   * from the module map. Absent when the agent declares no `dream`. The dream
   * reads {@link MemoryConfig.sessionsNamespace} and writes only
   * {@link MemoryConfig.namespace}.
   */
  readonly dream?: {
    /** Optional model id for synthesis; defaults to the agent's model. */
    readonly model?: string;
    /** Free-text guidance steering what the default synthesis keeps/merges/drops. */
    readonly instructions?: string;
    /** When to consolidate (consumed by the trigger, a later phase). */
    readonly schedule?: {
      readonly idleMs?: number;
      readonly cron?: string;
      readonly minSessions?: number;
    };
    /**
     * Full override of the consolidation pipeline. Live function resolved from
     * a `memory.{ts,...}` module — present only for module-backed memory.
     */
    readonly run?: (ctx: DreamContext) => void | Promise<void>;
  };
}

/**
 * Transient context key for the resolved {@link MemoryConfig}. Codec-less by
 * design — re-seeded per turn, never serialized (see file docs).
 */
export const MemoryConfigKey = new ContextKey<MemoryConfig>("eve.memory.config");
