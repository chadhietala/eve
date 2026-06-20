import { FsMemoryStore } from "#runtime/memory/fs-store.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { resolveWorkingNamespace } from "#runtime/memory/namespace.js";
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
  /** Resolved agent id; partitions every memory namespace. */
  readonly agentId: string;
  /** Channel continuation token, when the turn has one. */
  readonly continuationToken?: string;
  /** Stable root session id; the working-scope fallback partition. */
  readonly rootSessionId: string;
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
}

/**
 * Builds the per-turn {@link MemoryConfig} from a compiled memory definition.
 *
 * Computes the working namespace via {@link resolveWorkingNamespace} (thread-
 * scoped on a continuation token, session-scoped otherwise), instantiates the
 * default {@link FsMemoryStore} unless a live store was supplied, and passes
 * through the orientation and any author handlers. The result is a transient value
 * re-seeded each step under {@link MemoryConfigKey} — never serialized — so a
 * live store instance is safe to hold here.
 */
export function buildMemoryConfig(input: BuildMemoryConfigInput): MemoryConfig {
  const namespace = resolveWorkingNamespace({
    agentId: input.agentId,
    continuationToken: input.continuationToken,
    rootSessionId: input.rootSessionId,
  });

  const config: {
    root: string;
    store: MemoryStore;
    namespace: typeof namespace;
    orientation?: string;
    handlers?: BuildMemoryConfigInput["handlers"];
  } = {
    root: input.root,
    store: input.store ?? new FsMemoryStore(),
    namespace,
  };

  if (input.orientation !== undefined) {
    config.orientation = input.orientation;
  }

  if (input.handlers !== undefined) {
    config.handlers = input.handlers;
  }

  return config;
}
