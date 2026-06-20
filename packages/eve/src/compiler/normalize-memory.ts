import { stripLogicalPathExtension } from "#discover/filesystem.js";
import type { MemorySourceRef } from "#discover/manifest.js";
import type { CompiledMemory } from "#compiler/manifest.js";
import {
  loadModuleBackedDefinition,
  type ModuleBackedDefinitionLoadOptions,
} from "#compiler/normalize-helpers.js";
import { isBrandedMemoryDefinition, type MemoryDefinition } from "#public/definitions/memory.js";

/** Default mount point for the memory filesystem view. */
const DEFAULT_MEMORY_ROOT = "/memory";

/** Escape-hatch handler names recorded as present in the compiled manifest. */
const MEMORY_HANDLER_NAMES = ["onRead", "onWrite", "onList", "onGrep"] as const;

type MemoryHandlerName = (typeof MEMORY_HANDLER_NAMES)[number];

/**
 * Compiles one authored memory source (markdown `memory.md` or module-backed
 * `defineMemory`) into the serializable {@link CompiledMemory} projection
 * loaded by the runtime.
 *
 * The markdown form contributes only an `orientation` (its body) under the
 * default `/memory` root. The module form is brand-checked (it must come
 * through `defineMemory`) and contributes its `root`, `orientation`, and
 * presence flags for the custom `store` and any escape-hatch handlers; the
 * live store and handler functions are not serialized — they resolve from the
 * module map at runtime via the source's logical path.
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
  const handlerNames = MEMORY_HANDLER_NAMES.filter(
    (name): name is MemoryHandlerName => typeof definition[name] === "function",
  );

  const compiled: CompiledMemory = {
    name: stripLogicalPathExtension(source.logicalPath),
    logicalPath: source.logicalPath,
    root: definition.root ?? DEFAULT_MEMORY_ROOT,
    hasStore: definition.store !== undefined,
    handlerNames,
    sourceId: source.sourceId,
    sourceKind: source.sourceKind,
  };

  if (definition.orientation !== undefined) {
    return { ...compiled, orientation: definition.orientation };
  }

  return compiled;
}
