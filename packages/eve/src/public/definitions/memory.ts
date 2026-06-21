import type { LanguageModel } from "ai";

import type { ExactDefinition } from "#public/definitions/exact.js";
import type { MemoryStore } from "#runtime/memory/store.js";

/**
 * Symbol-based brand stamped by {@link defineMemory} on every definition.
 * Invisible in IntelliSense, checked at runtime so the compiler and the
 * memory lifecycle can validate that a memory definition came through the
 * `defineMemory` wrapper.
 */
export const MEMORY_BRAND = Symbol.for("eve:memory-brand");

/**
 * Returns true if `value` carries the {@link defineMemory} brand symbol.
 * Used by the compiler/normalizer to validate that a `memory.ts` export is
 * properly wrapped.
 */
export function isBrandedMemoryDefinition(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[MEMORY_BRAND] === true
  );
}

/**
 * The mounted `/memory` area as seen by a {@link DreamConfig.run} pipeline:
 * the consolidation's *output*. Reads and writes resolve against the
 * agent-scoped persistent memory namespace — never the raw-sessions area —
 * so a dream can fold sessions into the curated memory without ever mutating
 * its own source material.
 */
export interface DreamMemoryAccess {
  /** Reads the memory file at `path`, or `null` when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Writes `content` to the memory file at `path` (PUT semantics). */
  write(path: string, content: string): Promise<void>;
  /** Lists memory paths under `prefix`. */
  list(prefix: string): Promise<readonly string[]>;
}

/**
 * The context a memory consolidation ("dream") runs against.
 *
 * A dream reads the raw, immutable {@link DreamContext.sessions} transcripts
 * plus the current {@link DreamContext.memory} area and synthesizes a
 * consolidated memory back into `memory`. The sessions are the input and are
 * never written; the mounted memory area is the only output.
 */
export interface DreamContext {
  /**
   * Free-text guidance steering what the synthesis keeps, merges, and drops.
   * Comes from {@link DreamConfig.instructions}; absent when the author gave
   * none.
   */
  readonly instructions?: string;

  /** The resolved model the synthesis calls (the agent's model by default). */
  readonly model: LanguageModel;

  /**
   * The raw, immutable per-session transcripts — the dream's input. Each entry
   * is one session's full-fidelity JSONL dump keyed by its session id. Reading
   * these never mutates them.
   */
  readonly sessions: readonly { readonly sessionId: string; readonly transcript: string }[];

  /**
   * Read/write access to the mounted `/memory` area — the dream's output. This
   * is the only surface a dream writes to; the {@link DreamContext.sessions}
   * area is read-only.
   */
  readonly memory: DreamMemoryAccess;
}

/**
 * Configures the memory consolidation ("dream") pipeline that folds raw
 * session transcripts into the agent's curated `/memory` area.
 *
 * Every field is optional. With no `run`, the framework's built-in default
 * synthesis runs — a single guided model call that merges new sessions into
 * the existing memory. Provide `run` to replace the pipeline wholesale (e.g.
 * a knowledge-graph or RAG indexer). The dream is invoked on a trigger wired
 * up in a later phase; this config only describes the logic, not when it fires.
 */
export interface DreamConfig {
  /** Optional model id for synthesis; defaults to the agent's model. */
  readonly model?: string;

  /**
   * Free-text guidance steering what the default synthesis keeps, merges, and
   * drops. Passed through to {@link DreamContext.instructions}.
   */
  readonly instructions?: string;

  /**
   * When to consolidate. Consumed by the consolidation trigger (a later
   * phase); carried here as static config so it compiles into the manifest.
   */
  readonly schedule?: {
    /** Consolidate after the agent has been idle this many milliseconds. */
    readonly idleMs?: number;
    /** Consolidate on this cron expression. */
    readonly cron?: string;
    /** Only consolidate once at least this many new sessions have accrued. */
    readonly minSessions?: number;
  };

  /**
   * Full override of the consolidation pipeline. Receives the
   * {@link DreamContext} and is responsible for synthesizing and writing the
   * consolidated memory. When omitted, the built-in default synthesis runs.
   * Live function — resolved from the `memory.{ts,...}` module at runtime, not
   * serialized into the manifest.
   */
  readonly run?: (ctx: DreamContext) => void | Promise<void>;
}

/**
 * One named store mount in a {@link MemoryDefinition}.
 *
 * A store is a {@link MemoryStore} backend mounted at a path under
 * `/mnt/memory` with an access level. The `backend` is both the storage and
 * the sharing key: two agents that mount the same backend share the store's
 * curated memory and its transcripts (the namespace keys on the store name, not
 * the agent id).
 */
export interface StoreMount {
  /** The backing store — its storage, and the key two agents share by reusing. */
  readonly backend: MemoryStore;
  /**
   * Mount sub-path under `/mnt/memory`. Defaults to the store's name (the key
   * in {@link MemoryDefinition.stores}). e.g. a `notes` store with no `path`
   * mounts at `/mnt/memory/notes`.
   */
  readonly path?: string;
  /**
   * Access level for the agent. `"rw"` (default) lets the agent read and write
   * the curated area and dumps its transcripts into the store; `"ro"` lets it
   * read only — a write through the mount is rejected with an error the model
   * sees, and no transcripts are dumped into it.
   */
  readonly access?: "ro" | "rw";
}

/**
 * Public definition for an agent's memory layer authored in markdown or
 * TypeScript.
 *
 * Authored at the agent root as either `memory.md` or
 * `memory.{ts,cts,mts,js,cjs,mjs}`, or inside the `agent/memory/`
 * directory for multi-file setups. The `.md` variant supplies only the
 * {@link MemoryDefinition.orientation} (its markdown body) and declares NO
 * stores — live backends cannot be expressed in markdown, so a store-backed
 * memory layer requires the `memory.ts` form. With no `defineMemory` (no
 * memory source at all) the agent has no memory.
 *
 * Memory is a filesystem: the framework routes file-tool operations under
 * `/mnt/memory/<store-path>` to that store's backend, namespaced by the store
 * name. Non-filesystem access patterns (search/RAG/knowledge-graph) are built
 * with eve's normal tool system, not the memory layer.
 */
export interface MemoryDefinition {
  /**
   * The named stores this agent mounts, keyed by store name. Each value mounts
   * a {@link MemoryStore} backend at a path under `/mnt/memory` with an access
   * level. At most 8 stores — declaring more is a compile error. Markdown
   * memory (`memory.md`) cannot declare stores; use `memory.ts`.
   */
  readonly stores: Record<string, StoreMount>;

  /**
   * Orientation text injected as a system pointer (like instructions) —
   * the `memory.md` body or the `memory.ts` return. It is NOT a file
   * mounted under any store; it is read-only context that tells the agent how
   * to use its memory layer.
   */
  readonly orientation?: string;

  /**
   * Memory consolidation ("dream") configuration. When present, each `rw`
   * store's raw session transcripts are periodically folded into that store's
   * curated area by the built-in default synthesis or a {@link DreamConfig.run}
   * override. Absent means no consolidation runs.
   */
  readonly dream?: DreamConfig;
}

/**
 * Defines an agent's memory layer in TypeScript from a
 * {@link MemoryDefinition}.
 *
 * Use it to declare the named stores, provide orientation text, and configure
 * consolidation. For fixed orientation text with no stores, author `memory.md`
 * instead. The result is branded so the compiler and runtime can validate that
 * a memory definition came through this helper.
 */
export function defineMemory<TMemory extends MemoryDefinition>(
  definition: ExactDefinition<TMemory, MemoryDefinition>,
): TMemory {
  Object.assign(definition, { [MEMORY_BRAND]: true });
  return definition;
}
