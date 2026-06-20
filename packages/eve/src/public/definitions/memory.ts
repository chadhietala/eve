import type { LanguageModel } from "ai";

import type { ExactDefinition } from "#public/definitions/exact.js";
import type { DynamicResolveContext } from "#shared/dynamic-tool-definition.js";
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
 * One entry returned by a memory `list`/`onList`: a path plus its size in
 * bytes. Mirrors the `MemoryStore` listing shape so escape-hatch handlers
 * and the framework defaults agree on the wire format.
 */
export interface MemoryListEntry {
  readonly path: string;
  readonly size: number;
}

/**
 * One match returned by a memory `grep`/`onGrep`: the matching path, the
 * 1-based line number, and the line text.
 */
export interface MemoryGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
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
 * variant may additionally override the store and the
 * read/write/list/grep operations.
 *
 * The framework drives the default memory operations against an eve-owned
 * versioned {@link MemoryStore}, namespaced from the request's identity and
 * channel continuation token. The optional handlers below are escape
 * hatches that override those defaults; absent handlers fall back to the
 * framework implementation (convention over configuration).
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

  /**
   * Escape hatch overriding the default read of a memory path. Receives
   * the request-scoped resolve context. Return the stored bytes, or `null`
   * when the path does not exist.
   */
  readonly onRead?: (
    path: string,
    ctx: DynamicResolveContext,
  ) => Uint8Array | null | Promise<Uint8Array | null>;

  /**
   * Escape hatch overriding the default write of a memory path. Receives
   * the bytes to persist and the request-scoped resolve context.
   */
  readonly onWrite?: (
    path: string,
    bytes: Uint8Array,
    ctx: DynamicResolveContext,
  ) => void | Promise<void>;

  /**
   * Escape hatch overriding the default listing under a path prefix.
   * Receives the request-scoped resolve context and returns the entries
   * beneath `prefix`.
   */
  readonly onList?: (
    prefix: string,
    ctx: DynamicResolveContext,
  ) => readonly MemoryListEntry[] | Promise<readonly MemoryListEntry[]>;

  /**
   * Escape hatch overriding the default content search. Receives the
   * search `pattern`, an optional path `prefix` to scope the search, and
   * the request-scoped resolve context.
   */
  readonly onGrep?: (
    pattern: string,
    prefix: string,
    ctx: DynamicResolveContext,
  ) => readonly MemoryGrepMatch[] | Promise<readonly MemoryGrepMatch[]>;
}

/**
 * Defines an agent's memory layer in TypeScript from a
 * {@link MemoryDefinition}.
 *
 * Use it to override the memory root, swap the backing {@link MemoryStore},
 * provide orientation text, or supply `onRead`/`onWrite`/`onList`/`onGrep`
 * escape hatches over the framework defaults. For fixed orientation text
 * with no overrides, author `memory.md` instead. The result is branded so the
 * compiler and runtime can validate that a memory definition came through
 * this helper.
 */
export function defineMemory<TMemory extends MemoryDefinition>(
  definition: ExactDefinition<TMemory, MemoryDefinition>,
): TMemory {
  Object.assign(definition, { [MEMORY_BRAND]: true });
  return definition;
}
