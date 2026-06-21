/**
 * Memory-layer context keys.
 *
 * {@link MemoryConfigKey} carries the resolved per-turn memory configuration —
 * the live {@link MountedStore} backends, their mount paths and access, the
 * mount root, the orientation, and the static + live dream config. Because it
 * holds live (non-serializable) backends, the key is intentionally
 * **codec-less**: it is a transient value re-seeded each turn from the compiled
 * memory definition, and is never persisted at a step boundary. The compiled
 * definition (durable) is the source of truth; this is its hydrated,
 * request-scoped projection.
 */

import { ContextKey } from "#context/key.js";
import type { DreamContext } from "#public/definitions/memory.js";
import type { MemoryStore } from "#runtime/memory/store.js";

/**
 * One resolved store mounted into the turn's memory filesystem.
 *
 * `backend` is the live store and *is* the store's identity: two agents share a
 * store by pointing at the same backend, regardless of what each calls it.
 * `mountPath` is its absolute mount under the memory root (e.g.
 * `/mnt/memory/notes`); `access` gates writes through the mount. The curated and
 * transcripts namespaces are constant within a backend (see
 * {@link resolveStoreNamespace}), so they are not held here.
 */
export interface MountedStore {
  /** Local mount alias (the key in `defineMemory({ stores })`) — not the share key. */
  readonly name: string;
  /** The live backing store this mount routes to. */
  readonly backend: MemoryStore;
  /** Absolute mount path under the memory root, e.g. `/mnt/memory/notes`. */
  readonly mountPath: string;
  /** Access level: `"rw"` permits writes through the mount; `"ro"` rejects them. */
  readonly access: "ro" | "rw";
}

/**
 * The resolved memory configuration for the active turn, seeded into context
 * during bootstrap and read by the redirected file tools at execute time.
 */
export interface MemoryConfig {
  /** Absolute POSIX mount root the file tools redirect under, e.g. `/mnt/memory`. */
  readonly root: string;

  /**
   * The stores mounted under {@link MemoryConfig.root}. The redirect routes a
   * `/mnt/memory/...` path to the store whose `mountPath` is the longest
   * matching prefix.
   */
  readonly stores: readonly MountedStore[];

  /**
   * Orientation text (the `memory.ts` return) injected as a system pointer so
   * the model knows it has a memory filesystem and how to use it. Guidance, not
   * a file under the mount.
   */
  readonly orientation?: string;

  /**
   * The consolidated memory indexes (`MEMORY.md`) read from each mounted store's
   * curated namespace at seed time, joined and injected into the system prompt
   * so the agent's curated memory is in context from turn one (it can still
   * grep/read the rest on demand). Absent until a consolidation has written one.
   */
  readonly memoryIndex?: string;

  /**
   * Memory consolidation ("dream") configuration: the static fields the author
   * declared plus, for a module-backed memory, the live `run` override resolved
   * from the module map. Absent when the agent declares no `dream`. A dream
   * runs per `rw` store: it reads that store's transcripts namespace and writes
   * only its curated namespace.
   */
  readonly dream?: {
    /** Optional model id for synthesis; defaults to the agent's model. */
    readonly model?: string;
    /** Free-text guidance steering what the default synthesis keeps/merges/drops. */
    readonly instructions?: string;
    /** When to consolidate: idle re-arm window, cron backstop, and session floor. */
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
