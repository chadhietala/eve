import type { LanguageModel } from "ai";

import type { ExactDefinition } from "#public/definitions/exact.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { TranscriptStore } from "#runtime/transcripts/store.js";

/**
 * A duration: either a number of milliseconds, or a short suffix string the
 * framework parses — `"30d"`, `"12h"`, `"45m"`, `"90s"`. Used for the dream's
 * lookback window and for transcript retention.
 */
export type Duration = string | number;

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
 * Read/write access to one store, as given to a {@link DreamConfig.run} override.
 *
 * Reads and writes resolve against the store's mounted area (under
 * `/mnt/memory/<store>`) only — never the transcript log a dream reads from — so
 * a dream cannot mutate its own source material while folding sessions into
 * memory.
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
 * The context a dream runs against.
 *
 * A dream reads the raw, immutable {@link DreamContext.sessions} transcripts
 * plus the current {@link DreamContext.memory} area and synthesizes a
 * curated memory back into `memory`. The sessions are the input and are
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
   * Read/write access to the store (mounted under `/mnt/memory/<store>`). This is
   * the only surface a dream writes to; {@link DreamContext.sessions} is its
   * read-only input.
   */
  readonly memory: DreamMemoryAccess;
}

/**
 * Configures the dream pipeline that folds each `rw`
 * store's raw session transcripts into that store's curated area.
 *
 * Every field is optional. With no `run`, the framework's built-in default
 * synthesis runs — a single guided model call that merges new sessions into
 * the existing memory. Provide `run` to replace the pipeline wholesale (e.g.
 * a knowledge-graph or RAG indexer). It runs once per `rw` store. When the dream
 * fires is set by {@link DreamConfig.cron}; this config describes the logic.
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
   * How far back the dream mines transcripts — the lookback window
   * resolved against "now" when the dream fires (e.g. `"12h"`). The framework
   * gathers every session touched in that window. Defaults to a fixed backstop.
   */
  readonly window?: Duration;

  /**
   * Cron expression for when to dream (e.g. `"0 3 * * *"` for nightly).
   * The framework runs the dream on this cadence; a run whose window holds no
   * new sessions is a cheap no-op. Defaults to a daily cadence when omitted.
   */
  readonly cron?: string;

  /**
   * Full override of the dream pipeline (the escape hatch). Receives the
   * {@link DreamContext} and is responsible for synthesizing and writing the
   * curated memory. When omitted, the framework's declarative pipeline runs,
   * steered by {@link DreamConfig.instructions}. Live function — resolved from the
   * `memory.{ts,...}` module at runtime, not serialized into the manifest.
   */
  readonly run?: (ctx: DreamContext) => void | Promise<void>;
}

/**
 * Retention policy for the transcript log — an absolute lifetime after which a
 * session's transcript is pruned. Must outlive the dream's {@link
 * DreamConfig.window} (you cannot prune what a pending dream still needs).
 */
export interface TranscriptRetention {
  /** Prune transcripts whose last activity is older than this (e.g. `"30d"`). */
  readonly maxAge: Duration;
}

/**
 * Configures the eve-owned session transcript log: the durable backend it
 * writes to and how long entries live. Absent ⇒ the framework's default backend
 * (filesystem in dev) with a default retention tied to the dream window.
 */
export interface TranscriptConfig {
  /**
   * The durable {@link TranscriptStore} backend. Defaults to a filesystem store
   * in dev; production uses a durable backend (e.g. Vercel Blob).
   */
  readonly backend?: TranscriptStore;
  /** Retention policy; defaults to a multiple of the dream window. */
  readonly retention?: TranscriptRetention;
}

/**
 * One named store mount in a {@link MemoryDefinition}.
 *
 * A store is a {@link MemoryStore} backend mounted at a path under
 * `/mnt/memory` with an access level. The `backend` is both the storage and
 * the sharing key: two agents that mount the same backend share the store's
 * curated memory and its transcripts — regardless of what each names it
 * locally. The name is a mount alias, not the sharing key.
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
   * the curated area; `"ro"` lets it read only — a write through the mount is
   * rejected with an error the model sees.
   */
  readonly access?: "ro" | "rw";
  /**
   * What this store is for, in one line (e.g. "User preferences and per-project
   * facts."). Injected into the agent's — and the dream's — system prompt as the
   * mount note, so the dream files each fact into the store that fits.
   * The routing signal.
   */
  readonly description?: string;
}

/**
 * Public definition for an agent's memory layer authored in TypeScript.
 *
 * Authored at the agent root as `memory.{ts,cts,mts,js,cjs,mjs}`, or inside the
 * `agent/memory/` directory for multi-file setups. With no `defineMemory` (no
 * memory source at all) the agent has no memory.
 *
 * Memory is a filesystem: the framework routes file-tool operations under
 * `/mnt/memory/<store-path>` to that store's backend. Non-filesystem access
 * patterns (search/RAG/knowledge-graph) are built with eve's normal tool
 * system, not the memory layer.
 */
export interface MemoryDefinition {
  /**
   * The named stores this agent mounts, keyed by store name. Each value mounts
   * a {@link MemoryStore} backend at a path under `/mnt/memory` with an access
   * level. A memory layer must declare at least one store and at most 8 —
   * declaring zero or more than eight is a compile error.
   */
  readonly stores: Record<string, StoreMount>;

  /**
   * Orientation text injected as a system pointer (like instructions) — the
   * `memory.ts` return's `orientation` field. It is NOT a file mounted under
   * any store; it is read-only context that tells the agent how to use its
   * memory layer.
   */
  readonly orientation?: string;

  /**
   * Memory dream configuration. When present, the windowed
   * session transcripts are periodically folded into the curated stores by the
   * framework's declarative pipeline (steered by {@link DreamConfig.instructions})
   * or a {@link DreamConfig.run} override. Absent means no dream runs.
   */
  readonly dream?: DreamConfig;

  /**
   * The eve-owned session transcript log: its durable backend and retention.
   * Optional — when memory declares a `dream`, the framework provisions a default
   * transcript backend (filesystem in dev) if this is omitted.
   */
  readonly transcripts?: TranscriptConfig;
}

/**
 * Defines an agent's memory layer in TypeScript from a
 * {@link MemoryDefinition}.
 *
 * Use it to declare the named stores, provide orientation text, and configure
 * dream. A memory layer must declare at least one store. The result is
 * branded so the compiler and runtime can validate that a memory definition
 * came through this helper.
 */
export function defineMemory<TMemory extends MemoryDefinition>(
  definition: ExactDefinition<TMemory, MemoryDefinition>,
): TMemory {
  Object.assign(definition, { [MEMORY_BRAND]: true });
  return definition;
}
