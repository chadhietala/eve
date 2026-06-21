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
 * Public definition for an agent's memory layer authored in markdown or
 * TypeScript.
 *
 * Authored at the agent root as either `memory.md` or
 * `memory.{ts,cts,mts,js,cjs,mjs}`, or inside the `agent/memory/`
 * directory for multi-file setups. The `.md` variant supplies only the
 * {@link MemoryDefinition.orientation} (its markdown body); the `.ts`
 * variant may additionally swap the backing {@link MemoryStore}.
 *
 * Memory is a filesystem: the framework always routes `/memory` file-tool
 * operations to the {@link MemoryStore}, namespaced from the request's
 * identity and channel continuation token. There is no per-operation
 * override — a custom backend is supplied by swapping the `store`, and
 * non-filesystem access patterns (search/RAG/knowledge-graph) are built with
 * eve's normal tool system, not the memory layer.
 */
export interface MemoryDefinition {
  /**
   * Mount point for the memory filesystem view, as an absolute POSIX path.
   * Defaults to `"/memory"`. All read/write/list/grep paths are resolved
   * relative to this root.
   */
  readonly root?: string;

  /**
   * The backing store for this memory layer. When omitted the framework
   * supplies its default eve-owned versioned store (filesystem in dev,
   * blob/KV in prod). Provide one to swap the backend behind the same
   * interface.
   */
  readonly store?: MemoryStore;

  /**
   * Orientation text injected as a system pointer (like instructions) —
   * the `memory.md` body or the `memory.ts` return. It is NOT a file
   * mounted under the memory `root`; it is read-only context that tells
   * the agent how to use its memory layer.
   */
  readonly orientation?: string;

  /**
   * Memory consolidation ("dream") configuration. When present, the agent's
   * raw session transcripts are periodically folded into this curated memory
   * area by the built-in default synthesis or a {@link DreamConfig.run}
   * override. Absent means no consolidation runs.
   */
  readonly dream?: DreamConfig;
}

/**
 * Defines an agent's memory layer in TypeScript from a
 * {@link MemoryDefinition}.
 *
 * Use it to override the memory root, swap the backing {@link MemoryStore},
 * or provide orientation text. For fixed orientation text with no overrides,
 * author `memory.md` instead. The result is branded so the compiler and
 * runtime can validate that a memory definition came through this helper.
 */
export function defineMemory<TMemory extends MemoryDefinition>(
  definition: ExactDefinition<TMemory, MemoryDefinition>,
): TMemory {
  Object.assign(definition, { [MEMORY_BRAND]: true });
  return definition;
}
