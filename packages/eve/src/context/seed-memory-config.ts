import type { ContextContainer } from "#context/container.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import type { DreamContext, StoreMount } from "#public/definitions/memory.js";
import {
  buildMemoryConfig,
  type BuildMemoryConfigInput,
  type ResolvedStoreMount,
} from "#runtime/memory/config.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import { resolveStoreNamespace } from "#runtime/memory/namespace.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedMemory } from "#runtime/types.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/** The bundle fields config construction reads — the agent, module map, node id. */
type MemoryConfigBundle = Pick<
  CompiledRuntimeAgentBundle,
  "resolvedAgent" | "moduleMap" | "nodeId"
>;

type DreamRun = (ctx: DreamContext) => void | Promise<void>;

// The module-backed fields of a resolved memory definition needed for lookup.
interface MemoryModuleRef {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}

/** The live surfaces resolved from a `defineMemory` export's module. */
interface ResolvedMemoryModule {
  /** Live backends keyed by store name (the `backend` of each `StoreMount`). */
  readonly backends: Map<string, MemoryStore>;
  /** The live `dream.run` override, when the author supplied one. */
  readonly dreamRun?: DreamRun;
}

/**
 * Resolves the live store `backend`s and `dream.run` override from a
 * module-backed (`memory.{ts,...}`) `defineMemory` export, using the same module
 * map lookup as tools/connections/hooks.
 *
 * Exported for testing the resolution in isolation (the `seedMemoryConfig` entry
 * point needs a full bundle, which this avoids).
 */
export async function resolveMemoryModule(
  memory: MemoryModuleRef,
  moduleMap: Parameters<typeof loadResolvedModuleExport>[0]["moduleMap"],
  nodeId: string | undefined,
): Promise<ResolvedMemoryModule> {
  let exportValue: unknown;
  try {
    exportValue = await loadResolvedModuleExport({
      definition: {
        exportName: memory.exportName,
        logicalPath: memory.logicalPath,
        sourceId: memory.sourceId,
      },
      kindLabel: "memory",
      moduleMap,
      nodeId,
    });
  } catch (error) {
    if (error instanceof ResolveAgentError) {
      throw error;
    }
    throw new ResolveAgentError(
      `Failed to resolve memory definition from "${memory.logicalPath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { logicalPath: memory.logicalPath, sourceId: memory.sourceId },
    );
  }

  const record = expectObjectRecord(
    exportValue,
    `Expected the memory export from "${memory.logicalPath}" to be an object.`,
  );

  const backends = new Map<string, MemoryStore>();
  const storesRecord = record.stores;
  if (storesRecord !== null && typeof storesRecord === "object") {
    for (const [name, mount] of Object.entries(storesRecord as Record<string, unknown>)) {
      if (mount !== null && typeof mount === "object") {
        const backend = (mount as StoreMount).backend;
        if (backend !== undefined) {
          backends.set(name, backend);
        }
      }
    }
  }

  const resolved: { backends: Map<string, MemoryStore>; dreamRun?: DreamRun } = { backends };

  // The dream's static config is serialized into the manifest, but its `run`
  // override is a live function — only reachable from the module export. Pull it
  // here so the same module-map lookup that resolves the backends also resolves
  // the consolidation override.
  const dream = record.dream;
  if (
    dream !== null &&
    typeof dream === "object" &&
    typeof (dream as Record<string, unknown>).run === "function"
  ) {
    resolved.dreamRun = (dream as Record<string, unknown>).run as DreamRun;
  }

  return resolved;
}

/**
 * Builds a {@link MemoryConfig} from a compiled bundle **without** a turn
 * context (no {@link ContextContainer}).
 *
 * Reads the resolved memory off the bundle, resolves the live store backends and
 * `dream.run` override from the module map, and mounts each compiled store
 * (matched to its live backend by name) into the config. Returns `undefined`
 * when the agent declares no memory layer. A declared memory layer always has at
 * least one store (enforced at compile time).
 *
 * This is the shared construction the turn path ({@link seedMemoryConfig}) and
 * the background consolidation path both build on, so an off-turn dream sees
 * exactly the same backends, namespaces, and dream config a turn would — without
 * the per-step recall read, which only the turn path needs.
 */
export async function buildMemoryConfigForBundle(
  bundle: MemoryConfigBundle,
): Promise<MemoryConfig | undefined> {
  const memory = bundle.resolvedAgent.memory;
  if (memory === undefined) {
    return undefined;
  }

  const resolved = await resolveMemoryModule(memory, bundle.moduleMap, bundle.nodeId);
  const stores = mountStores(memory, resolved.backends);

  const input: Mutable<BuildMemoryConfigInput> = {
    root: memory.root,
    stores,
  };

  if (memory.orientation !== undefined) {
    input.orientation = memory.orientation;
  }

  // The static dream config rides the compiled manifest; the live `run` override
  // is grafted on only when the module exposed one. Absent both, no dream is
  // attached and consolidation is a no-op for this agent.
  const dream = buildDreamConfig(memory.dream, resolved.dreamRun);
  if (dream !== undefined) {
    input.dream = dream;
  }

  return buildMemoryConfig(input);
}

/**
 * Matches each compiled store to its live backend by name. A compiled store with
 * no resolvable backend is a build/runtime mismatch — fail loudly rather than
 * silently dropping a mount the model expects.
 */
function mountStores(
  memory: ResolvedMemory,
  backends: Map<string, MemoryStore>,
): ResolvedStoreMount[] {
  return memory.stores.map((store) => {
    const backend = backends.get(store.name);
    if (backend === undefined) {
      throw new ResolveAgentError(
        `Memory store "${store.name}" in "${memory.logicalPath}" has no resolvable backend.`,
        { logicalPath: memory.logicalPath, sourceId: memory.sourceId },
      );
    }
    const mount: Mutable<ResolvedStoreMount> = { name: store.name, backend };
    if (store.path !== undefined) {
      mount.path = store.path;
    }
    if (store.access !== undefined) {
      mount.access = store.access;
    }
    return mount;
  });
}

/**
 * Seeds {@link MemoryConfigKey} for the active step when the resolved agent
 * declares a memory layer with mountable stores.
 *
 * Runs on every step (the {@link MemoryConfigKey} is codec-less and transient,
 * so it must be rebuilt each step rather than carried across step boundaries).
 * Delegates config construction to {@link buildMemoryConfigForBundle} so the turn
 * path and the background path build the config identically, then layers on the
 * turn-only recall read. When the agent has no memory layer, nothing is seeded so
 * non-memory agents are unaffected.
 */
export async function seedMemoryConfig(ctx: ContextContainer): Promise<void> {
  const bundle = ctx.get(BundleKey);
  if (bundle === undefined) {
    return;
  }

  const config = await buildMemoryConfigForBundle(bundle);
  if (config === undefined) {
    return;
  }

  // Recall: surface each store's consolidated memory index in the system prompt
  // from turn one, so the agent doesn't have to discover it. The rest of memory
  // stays grep/read-on-demand through the file tools. This read is turn-only —
  // the background consolidation path never seeds the prompt, so it does not run
  // it.
  const memoryIndex = await readMemoryIndexes(config);
  ctx.set(MemoryConfigKey, memoryIndex === undefined ? config : { ...config, memoryIndex });
}

/** Path of the consolidated memory index within each store's curated namespace. */
const MEMORY_INDEX_PATH = "MEMORY.md";

const decoder = new TextDecoder();

/**
 * Reads each mounted store's curated `MEMORY.md` and joins the present ones,
 * labeled by store name, into a single recall block. Absent indexes are omitted;
 * returns `undefined` when no store has one.
 */
async function readMemoryIndexes(config: MemoryConfig): Promise<string | undefined> {
  const sections: string[] = [];
  for (const store of config.stores) {
    const ns = resolveStoreNamespace();
    const bytes = await store.backend.read(ns, MEMORY_INDEX_PATH);
    if (bytes === null) {
      continue;
    }
    sections.push(`## ${store.name}\n\n${decoder.decode(bytes)}`);
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function buildDreamConfig(
  staticDream: ResolvedMemory["dream"],
  run: DreamRun | undefined,
): MemoryConfig["dream"] {
  if (staticDream === undefined && run === undefined) {
    return undefined;
  }

  // `hasRun` is a manifest-only marker telling the runtime whether to look for
  // the live override; the resolved `run` already carries that answer, so it is
  // dropped from the runtime config.
  const { hasRun: _hasRun, ...rest } = staticDream ?? { hasRun: false };
  const dream: NonNullable<MemoryConfig["dream"]> & { run?: DreamRun } = { ...rest };

  if (run !== undefined) {
    dream.run = run;
  }

  return dream;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
