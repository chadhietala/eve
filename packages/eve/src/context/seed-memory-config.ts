import type { ContextContainer } from "#context/container.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import type { DreamContext, MemoryDefinition } from "#public/definitions/memory.js";
import { buildMemoryConfig, type BuildMemoryConfigInput } from "#runtime/memory/config.js";
import type { MemoryConfig } from "#runtime/memory/keys.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedMemory } from "#runtime/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

type DreamRun = (ctx: DreamContext) => void | Promise<void>;

type MemoryHandlers = Pick<MemoryDefinition, "onRead" | "onWrite" | "onList" | "onGrep">;
const HANDLER_NAMES = ["onRead", "onWrite", "onList", "onGrep"] as const;

// The module-backed fields of a resolved memory definition needed for lookup.
interface MemoryModuleRef {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}

/**
 * Resolves the live `store`, escape-hatch handlers, and `dream.run` override
 * from a module-backed (`memory.{ts,...}`) `defineMemory` export, using the
 * same module map lookup as tools/connections/hooks. Markdown memory has no
 * live surfaces, so this is only consulted for `sourceKind === "module"`.
 *
 * Exported for testing the resolution in isolation (the `seedMemoryConfig`
 * entry point needs a full bundle, which this avoids).
 */
export async function resolveMemoryModule(
  memory: MemoryModuleRef,
  moduleMap: Parameters<typeof loadResolvedModuleExport>[0]["moduleMap"],
  nodeId: string | undefined,
): Promise<{ store?: MemoryStore; handlers?: MemoryHandlers; dreamRun?: DreamRun }> {
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

  const resolved: { store?: MemoryStore; handlers?: MemoryHandlers; dreamRun?: DreamRun } = {};
  if (record.store !== undefined) {
    resolved.store = record.store as MemoryStore;
  }

  const handlers: Record<string, unknown> = {};
  for (const name of HANDLER_NAMES) {
    if (typeof record[name] === "function") {
      handlers[name] = record[name];
    }
  }
  if (Object.keys(handlers).length > 0) {
    resolved.handlers = handlers as MemoryHandlers;
  }

  // The dream's static config is serialized into the manifest, but its `run`
  // override is a live function — only reachable from the module export. Pull
  // it here so the same module-map lookup that resolves the store and handlers
  // also resolves the consolidation override.
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
 * Seeds {@link MemoryConfigKey} for the active step when the resolved agent
 * declares a memory layer.
 *
 * Runs on every step (the {@link MemoryConfigKey} is codec-less and transient,
 * so it must be rebuilt each step rather than carried across step boundaries).
 * Reads the resolved memory off the active {@link BundleKey} bundle, derives the
 * agent-scoped mounted and raw-sessions namespaces from the agent id, and — for
 * a module-backed (`memory.{ts,...}`) definition — resolves the live store and
 * escape-hatch handlers from the module map. When the agent has no memory
 * layer, nothing is seeded so non-memory agents are unaffected.
 */
export async function seedMemoryConfig(ctx: ContextContainer): Promise<void> {
  const bundle = ctx.get(BundleKey);
  if (bundle === undefined) {
    return;
  }
  const memory = bundle.resolvedAgent.memory;
  if (memory === undefined) {
    return;
  }

  const input: Mutable<BuildMemoryConfigInput> = {
    root: memory.root,
    agentId: bundle.resolvedAgent.config.name,
  };

  if (memory.orientation !== undefined) {
    input.orientation = memory.orientation;
  }

  let dreamRun: DreamRun | undefined;
  if (memory.sourceKind === "module") {
    const resolved = await resolveMemoryModule(memory, bundle.moduleMap, bundle.nodeId);
    if (resolved.store !== undefined) {
      input.store = resolved.store;
    }
    if (resolved.handlers !== undefined) {
      input.handlers = resolved.handlers;
    }
    dreamRun = resolved.dreamRun;
  }

  // The static dream config rides the compiled manifest; the live `run` override
  // is grafted on only when the module exposed one. Absent both, no dream is
  // attached and consolidation is a no-op for this agent.
  const dream = buildDreamConfig(memory.dream, dreamRun);
  if (dream !== undefined) {
    input.dream = dream;
  }

  ctx.set(MemoryConfigKey, buildMemoryConfig(input));
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
