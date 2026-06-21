import type { MemoryConfig, MountedStore } from "#runtime/memory/keys.js";
import type { MemoryStore } from "#runtime/memory/store.js";

/** One store mount resolved to its live backend, ready to be mounted. */
export interface ResolvedStoreMount {
  /** Store name (the key in `defineMemory({ stores })`). */
  readonly name: string;
  /** The live backing store resolved from the module map. */
  readonly backend: MemoryStore;
  /** Mount sub-path under the root; defaults to the store name when omitted. */
  readonly path?: string;
  /** Access level; defaults to `"rw"` when omitted. */
  readonly access?: "ro" | "rw";
}

/**
 * Inputs for {@link buildMemoryConfig}.
 *
 * `stores` carries the live, non-serializable backends a `memory.ts`
 * `defineMemory` export supplies. They are resolved from the compiled module map
 * at runtime (the same way authored tools resolve their modules) and threaded in
 * here.
 */
export interface BuildMemoryConfigInput {
  /** Absolute POSIX mount root the file tools redirect under, e.g. `/mnt/memory`. */
  readonly root: string;
  /** The resolved store mounts (each carrying its live backend). */
  readonly stores: readonly ResolvedStoreMount[];
  /** Orientation text injected as a system pointer (the `memory.ts` return). */
  readonly orientation?: string;
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
 * Mounts each store at `root + "/" + (path ?? name)` with `access` defaulting to
 * `"rw"`, and passes through the orientation and dream. The result is a transient
 * value re-seeded each step under {@link MemoryConfigKey} — never serialized — so
 * live backends are safe to hold here.
 */
export function buildMemoryConfig(input: BuildMemoryConfigInput): MemoryConfig {
  const stores: MountedStore[] = input.stores.map((store) => ({
    name: store.name,
    backend: store.backend,
    mountPath: `${input.root}/${store.path ?? store.name}`,
    access: store.access ?? "rw",
  }));

  const config: {
    root: string;
    stores: MountedStore[];
    orientation?: string;
    dream?: MemoryConfig["dream"];
  } = {
    root: input.root,
    stores,
  };

  if (input.orientation !== undefined) {
    config.orientation = input.orientation;
  }

  if (input.dream !== undefined) {
    config.dream = input.dream;
  }

  return config;
}
