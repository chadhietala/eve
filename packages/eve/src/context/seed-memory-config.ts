import type { HarnessSession } from "#harness/types.js";
import type { ContextContainer } from "#context/container.js";
import { expectObjectRecord } from "#internal/authored-module.js";
import type { MemoryDefinition } from "#public/definitions/memory.js";
import { buildMemoryConfig, type BuildMemoryConfigInput } from "#runtime/memory/config.js";
import { MemoryConfigKey } from "#runtime/memory/keys.js";
import type { MemoryStore } from "#runtime/memory/store.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

type MemoryHandlers = Pick<MemoryDefinition, "onRead" | "onWrite" | "onList" | "onGrep">;
const HANDLER_NAMES = ["onRead", "onWrite", "onList", "onGrep"] as const;

// The module-backed fields of a resolved memory definition needed for lookup.
interface MemoryModuleRef {
  readonly exportName?: string;
  readonly logicalPath: string;
  readonly sourceId: string;
}

/**
 * Resolves the live `store` and escape-hatch handlers from a module-backed
 * (`memory.{ts,...}`) `defineMemory` export, using the same module map lookup
 * as tools/connections/hooks. Markdown memory has no live surfaces, so this is
 * only consulted for `sourceKind === "module"`.
 *
 * Exported for testing the resolution in isolation (the `seedMemoryConfig`
 * entry point needs a full bundle, which this avoids).
 */
export async function resolveMemoryModule(
  memory: MemoryModuleRef,
  moduleMap: Parameters<typeof loadResolvedModuleExport>[0]["moduleMap"],
  nodeId: string | undefined,
): Promise<{ store?: MemoryStore; handlers?: MemoryHandlers }> {
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

  const resolved: { store?: MemoryStore; handlers?: MemoryHandlers } = {};
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

  return resolved;
}

/**
 * Seeds {@link MemoryConfigKey} for the active step when the resolved agent
 * declares a memory layer.
 *
 * Runs on every step (the {@link MemoryConfigKey} is codec-less and transient,
 * so it must be rebuilt each step rather than carried across step boundaries).
 * Reads the resolved memory off the active {@link BundleKey} bundle, derives the
 * working namespace from the session's continuation token / root session id /
 * agent id, and — for a module-backed (`memory.{ts,...}`) definition — resolves
 * the live store and escape-hatch handlers from the module map. When the agent
 * has no memory
 * layer, nothing is seeded so non-memory agents are unaffected.
 */
export async function seedMemoryConfig(
  ctx: ContextContainer,
  session: HarnessSession,
): Promise<void> {
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
    rootSessionId: session.rootSessionId ?? session.sessionId,
  };

  if (memory.orientation !== undefined) {
    input.orientation = memory.orientation;
  }

  if (session.continuationToken.length > 0) {
    input.continuationToken = session.continuationToken;
  }

  if (memory.sourceKind === "module") {
    const { store, handlers } = await resolveMemoryModule(memory, bundle.moduleMap, bundle.nodeId);
    if (store !== undefined) {
      input.store = store;
    }
    if (handlers !== undefined) {
      input.handlers = handlers;
    }
  }

  ctx.set(MemoryConfigKey, buildMemoryConfig(input));
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
