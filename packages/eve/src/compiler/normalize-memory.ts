import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { MemorySourceRef } from "#discover/manifest.js";
import type {
  CompiledDream,
  CompiledMemory,
  CompiledStore,
  CompiledTranscripts,
} from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import {
  isBrandedMemoryDefinition,
  type DreamConfig,
  type MemoryDefinition,
  type StoreMount,
  type TranscriptConfig,
} from "#public/definitions/memory.js";

/** Default mount root for the memory filesystem view. */
const DEFAULT_MEMORY_ROOT = "/mnt/memory";

/** Maximum number of stores an agent may declare. */
const MAX_STORES = 8;

/**
 * Compiles one authored memory source (module-backed `defineMemory`) into the
 * serializable {@link CompiledMemory} projection loaded by the runtime.
 *
 * Memory is authored in TypeScript only. The export is brand-checked (it must
 * come through `defineMemory`) and contributes its `orientation`, `dream`, and
 * the static shape (name/path/access) of each store; the live backends are not
 * serialized — they resolve from the module map at runtime via the source's
 * logical path. A memory layer must declare at least one store, and at most
 * {@link MAX_STORES}; violating either bound is a compile error.
 */
export async function compileMemoryEntry(
  agentRoot: string,
  source: MemorySourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledMemory> {
  const exportValue = await loadModuleBackedDefinition({
    agentRoot,
    externalDependencies: options.externalDependencies,
    kind: "memory",
    source,
  });

  if (!isBrandedMemoryDefinition(exportValue)) {
    throw new Error(
      `Expected the memory export "${source.exportName ?? "default"}" from "${source.logicalPath}" to be wrapped with defineMemory().`,
    );
  }

  return projectCompiledMemory(exportValue as MemoryDefinition, source);
}

/**
 * Projects a branded {@link MemoryDefinition} and its module source ref into
 * the serializable {@link CompiledMemory}. Exposed for unit tests that exercise
 * the projection and its store-count validation without loading a real module
 * from disk.
 */
export function projectCompiledMemory(
  definition: MemoryDefinition,
  source: MemorySourceRef,
): CompiledMemory {
  const stores = projectCompiledStores(definition, source);

  const compiled: CompiledMemory = {
    name: stripLogicalPathExtension(source.logicalPath),
    logicalPath: source.logicalPath,
    root: DEFAULT_MEMORY_ROOT,
    stores,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };

  let projected: CompiledMemory = compiled;

  if (definition.dream !== undefined) {
    projected = { ...projected, dream: projectCompiledDream(definition.dream) };
  }
  if (definition.transcripts !== undefined) {
    projected = { ...projected, transcripts: projectCompiledTranscripts(definition.transcripts) };
  }
  if (definition.orientation !== undefined) {
    projected = { ...projected, orientation: definition.orientation };
  }

  return projected;
}

/**
 * Projects the authored `stores` map into the static, serializable
 * {@link CompiledStore} list. A memory layer must mount at least one store —
 * declaring zero is a compile error (the layer would otherwise be a silent
 * no-op). Enforces the {@link MAX_STORES} cap with a clear diagnostic, and
 * preserves only the durable fields (name/path/access) — the live backend
 * resolves from the module map.
 */
function projectCompiledStores(
  definition: MemoryDefinition,
  source: MemorySourceRef,
): CompiledStore[] {
  const entries = Object.entries(definition.stores ?? {});

  if (entries.length === 0) {
    throw new Error(
      `Memory definition in "${source.logicalPath}" declares no stores; a memory layer must mount at least one store.`,
    );
  }

  if (entries.length > MAX_STORES) {
    throw new Error(
      `Memory definition in "${source.logicalPath}" declares ${entries.length} stores; at most ${MAX_STORES} are allowed.`,
    );
  }

  return entries.map(([name, mount]) => projectCompiledStore(name, mount));
}

function projectCompiledStore(name: string, mount: StoreMount): CompiledStore {
  const compiled: Mutable<CompiledStore> = { name };
  if (mount.path !== undefined) {
    compiled.path = mount.path;
  }
  if (mount.access !== undefined) {
    compiled.access = mount.access;
  }
  if (mount.description !== undefined) {
    compiled.description = mount.description;
  }
  return compiled;
}

/**
 * Projects an authored {@link DreamConfig} into its static, serializable
 * {@link CompiledDream} shape.
 *
 * Only the durable fields (`model`, `instructions`, `window`, `cron`) are
 * serialized; the live `run` override is collapsed to a `hasRun` flag because
 * the function itself resolves from the module map at runtime, not the manifest.
 */
function projectCompiledDream(dream: DreamConfig): CompiledDream {
  const compiled: Mutable<CompiledDream> = { hasRun: dream.run !== undefined };

  if (dream.model !== undefined) {
    compiled.model = dream.model;
  }
  if (dream.instructions !== undefined) {
    compiled.instructions = dream.instructions;
  }
  if (dream.window !== undefined) {
    compiled.window = dream.window;
  }
  if (dream.cron !== undefined) {
    compiled.cron = dream.cron;
  }

  return compiled;
}

/**
 * Projects the authored {@link TranscriptConfig} into its static, serializable
 * shape. Only `retention` is durable; the live `backend` is collapsed to a
 * `hasBackend` flag because it resolves from the module map at runtime, exactly
 * like a store backend or the dream `run`.
 */
function projectCompiledTranscripts(transcripts: TranscriptConfig): CompiledTranscripts {
  const compiled: Mutable<CompiledTranscripts> = { hasBackend: transcripts.backend !== undefined };
  if (transcripts.retention !== undefined) {
    compiled.retention = { maxAge: transcripts.retention.maxAge };
  }
  return compiled;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
