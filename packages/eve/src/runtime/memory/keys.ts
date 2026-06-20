/**
 * Memory-layer context keys.
 *
 * {@link MemoryConfigKey} carries the resolved per-turn memory configuration —
 * a live {@link MemoryStore} instance, the computed namespace, the mount root,
 * the orientation, and the author escape-hatch handlers. Because it holds a live
 * (non-serializable) store, the key is intentionally **codec-less**: it is a
 * transient value re-seeded each turn from the compiled memory definition, and
 * is never persisted at a step boundary. The compiled definition (durable) is
 * the source of truth; this is its hydrated, request-scoped projection.
 */

import { ContextKey } from "#context/key.js";
import type { MemoryDefinition } from "#public/definitions/memory.js";
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
   * The namespace this turn's memory is partitioned under. For slice 1 this is
   * always a `working` namespace keyed by the channel continuation token.
   */
  readonly namespace: MemoryNamespace;

  /**
   * Orientation text (the `memory.md` body or `memory.ts` return) injected as a
   * system pointer so the model knows it has a memory filesystem and how to use
   * it. Guidance, not a file under the mount.
   */
  readonly orientation?: string;

  /**
   * Author-supplied escape hatches overriding the framework's default IO. When
   * absent, the framework drives the default store-backed behavior (convention
   * over configuration).
   */
  readonly handlers?: Pick<MemoryDefinition, "onRead" | "onWrite" | "onList" | "onGrep">;
}

/**
 * Transient context key for the resolved {@link MemoryConfig}. Codec-less by
 * design — re-seeded per turn, never serialized (see file docs).
 */
export const MemoryConfigKey = new ContextKey<MemoryConfig>("eve.memory.config");
