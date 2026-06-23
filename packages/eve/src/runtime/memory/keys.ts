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
import type { DreamConfig, Duration } from "#public/definitions/memory.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { TranscriptStore } from "#runtime/transcripts/store.js";

/**
 * One resolved store mounted into the turn's memory filesystem.
 *
 * `backend` is the live store and *is* the store's identity: two agents share a
 * store by pointing at the same backend, regardless of what each calls it.
 * `mountPath` is its absolute mount under the memory root (e.g.
 * `/mnt/memory/notes`); `access` gates writes through the mount.
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
  /** One-line purpose; the routing signal a dream uses to file each fact. */
  readonly description?: string;
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
   * The eve-owned session transcript log: one append-only record per session,
   * shared by the whole agent (not per store). The harness records turns into it
   * as a session runs; a dream reads a window of it. Present only when the agent
   * declares a `dream` (transcripts are recorded only when there is a
   * dream to feed). The backend is live (non-serializable), resolved each
   * turn like the store backends.
   */
  readonly transcriptStore?: TranscriptStore;

  /**
   * Transcript retention: an absolute lifetime (e.g. `"30d"`) after which a
   * session's transcript is pruned by the dream run. Absent ⇒ a default
   * tied to the dream window.
   */
  readonly transcriptRetention?: Duration;

  /**
   * A listing of each mounted store's files, read at seed time and injected into
   * the system prompt so the agent knows what memory exists from turn one (it
   * reads or greps the contents on demand). There is no privileged index file;
   * this reflects whatever files the dream and the agent have written. Absent
   * until at least one store holds a file.
   */
  readonly memoryListing?: string;

  /**
   * The resolved memory dream: exactly the authored {@link DreamConfig} — its
   * static fields plus, for a module-backed memory, the live `run` override
   * resolved from the module map. Absent when the agent declares no `dream`. A
   * dream reads one window of the session-level {@link MemoryConfig.transcriptStore}
   * and folds it into each `rw` store.
   */
  readonly dream?: DreamConfig;
}

/**
 * Transient context key for the resolved {@link MemoryConfig}. Codec-less by
 * design — re-seeded per turn, never serialized (see file docs).
 */
export const MemoryConfigKey = new ContextKey<MemoryConfig>("eve.memory.config");
