import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { resolveMemoryNamespace, resolveSessionsNamespace } from "#runtime/memory/namespace.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import type { MemoryDefinition } from "#public/definitions/memory.js";

/**
 * Inputs for {@link buildMemoryConfig}.
 *
 * `store` and `handlers` carry the live, non-serializable surfaces that a
 * `memory.{ts,...}` `defineMemory` export supplies. They are resolved from the
 * compiled module map at runtime (the same way authored tools resolve their
 * modules) and threaded in here; absent, the framework falls back to its
 * default {@link FsMemoryStore} and store-backed handlers.
 */
export interface BuildMemoryConfigInput {
  /** Absolute POSIX mount root the file tools redirect under, e.g. `/memory`. */
  readonly root: string;
  /** Orientation text injected as a system pointer (memory.md body / memory.ts return). */
  readonly orientation?: string;
  /** Resolved agent id; partitions every memory namespace (the agent-scoped key). */
  readonly agentId: string;
  /**
   * Live store resolved from a `defineMemory` export. When omitted the
   * framework default {@link FsMemoryStore} is used.
   */
  readonly store?: MemoryStore;
  /**
   * Live escape-hatch handlers resolved from a `defineMemory` export. When
   * omitted the framework drives default store-backed behavior.
   */
  readonly handlers?: Pick<MemoryDefinition, "onRead" | "onWrite" | "onList" | "onGrep">;

  /**
   * Memory consolidation ("dream") config: the static fields projected from the
   * compiled manifest, optionally carrying the live `run` override resolved from
   * a `defineMemory` export. Absent when the agent declares no `dream`.
   */
  readonly dream?: MemoryConfig["dream"];
}

/**
 * Builds the per-turn {@link MemoryConfig} from a compiled memory definition.
 *
 * Resolves the mounted, agent-scoped persistent namespace via
 * {@link resolveMemoryNamespace} and the off-mount raw-sessions namespace via
 * {@link resolveSessionsNamespace}, instantiates the default
 * {@link FsMemoryStore} unless a live store was supplied, and passes through the
 * orientation and any author handlers. The result is a transient value
 * re-seeded each step under {@link MemoryConfigKey} — never serialized — so a
 * live store instance is safe to hold here.
 */
export function buildMemoryConfig(input: BuildMemoryConfigInput): MemoryConfig {
  const namespace = resolveMemoryNamespace({ agentId: input.agentId });
  const sessionsNamespace = resolveSessionsNamespace({ agentId: input.agentId });

  const config: {
    root: string;
    store: MemoryStore;
    namespace: typeof namespace;
    sessionsNamespace: typeof sessionsNamespace;
    orientation?: string;
    handlers?: BuildMemoryConfigInput["handlers"];
    dream?: MemoryConfig["dream"];
  } = {
    root: input.root,
    store: input.store ?? new FsMemoryStore(),
    namespace,
    sessionsNamespace,
  };

  if (input.orientation !== undefined) {
    config.orientation = input.orientation;
  }

  if (input.handlers !== undefined) {
    config.handlers = input.handlers;
  }

  if (input.dream !== undefined) {
    config.dream = input.dream;
  }

  return config;
}
