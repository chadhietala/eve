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
