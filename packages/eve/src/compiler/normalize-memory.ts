import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { MemorySourceRef } from "#discover/manifest.js";
import type { CompiledDream, CompiledMemory } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import {
  isBrandedMemoryDefinition,
  type DreamConfig,
  type MemoryDefinition,
} from "#public/definitions/memory.js";

/** Default mount point for the memory filesystem view. */
const DEFAULT_MEMORY_ROOT = "/memory";

/**
 * Compiles one authored memory source (markdown `memory.md` or module-backed
 * `defineMemory`) into the serializable {@link CompiledMemory} projection
 * loaded by the runtime.
 *
 * The markdown form contributes only an `orientation` (its body) under the
 * default `/memory` root. The module form is brand-checked (it must come
 * through `defineMemory`) and contributes its `root`, `orientation`, and a
 * presence flag for the custom `store`; the live store is not serialized — it
 * resolves from the module map at runtime via the source's logical path.
 */
export async function compileMemoryEntry(
  agentRoot: string,
  source: MemorySourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledMemory> {
  if (source.sourceKind === "markdown") {
    return projectCompiledMemory(source.definition, source);
  }

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

function projectCompiledMemory(
  definition: MemoryDefinition,
  source: MemorySourceRef,
): CompiledMemory {
  const compiled: CompiledMemory = {
    name: stripLogicalPathExtension(source.logicalPath),
    logicalPath: source.logicalPath,
    root: definition.root ?? DEFAULT_MEMORY_ROOT,
    hasStore: definition.store !== undefined,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };

  const withDream =
    definition.dream === undefined
      ? compiled
      : { ...compiled, dream: projectCompiledDream(definition.dream) };

  if (definition.orientation !== undefined) {
    return { ...withDream, orientation: definition.orientation };
  }

  return withDream;
}

/**
 * Projects an authored {@link DreamConfig} into its static, serializable
 * {@link CompiledDream} shape.
 *
 * Only the durable fields (`model`, `instructions`, `schedule`) are serialized;
 * the live `run` override is collapsed to a `hasRun` flag because the function
 * itself resolves from the module map at runtime, not from the manifest.
 */
function projectCompiledDream(dream: DreamConfig): CompiledDream {
  const compiled: Mutable<CompiledDream> = { hasRun: dream.run !== undefined };

  if (dream.model !== undefined) {
    compiled.model = dream.model;
  }
  if (dream.instructions !== undefined) {
    compiled.instructions = dream.instructions;
  }
  if (dream.schedule !== undefined) {
    compiled.schedule = { ...dream.schedule };
  }

  return compiled;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
