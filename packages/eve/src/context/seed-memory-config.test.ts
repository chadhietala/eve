import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveMemoryModule } from "#context/seed-memory-config.js";
import { defineMemory } from "#public/definitions/memory.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

/**
 * Builds a minimal {@link CompiledModuleMap} exposing one authored module under
 * one source id at the root node — mirrors the hook/tool resolution tests.
 */
function buildModuleMap(sourceId: string, moduleNamespace: unknown): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: { [sourceId]: moduleNamespace },
      },
    },
  } as CompiledModuleMap;
}

const SOURCE_ID = "agent/memory.ts";
const REF = { exportName: undefined, logicalPath: SOURCE_ID, sourceId: SOURCE_ID };

describe("resolveMemoryModule", () => {
  it("threads the live store and handlers from a defineMemory export", async () => {
    const store = new InMemoryMemoryStore();
    const onWrite = (_path: string): void => undefined;
    const onGrep = (): never[] => [];
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({ store, onWrite, onGrep }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    // The same live instances are threaded through — not copies.
    expect(resolved.store).toBe(store);
    expect(resolved.handlers?.onWrite).toBe(onWrite);
    expect(resolved.handlers?.onGrep).toBe(onGrep);
    expect(resolved.handlers?.onRead).toBeUndefined();
  });

  it("returns nothing for an export that declares neither store nor handlers", async () => {
    const moduleMap = buildModuleMap(SOURCE_ID, { default: defineMemory({ root: "/memory" }) });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    expect(resolved.store).toBeUndefined();
    expect(resolved.handlers).toBeUndefined();
    expect(resolved.dreamRun).toBeUndefined();
  });

  it("threads the live dream.run override from a defineMemory export", async () => {
    const run = async (): Promise<void> => undefined;
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({ dream: { instructions: "merge", run } }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    // The live function is threaded through verbatim — not a copy.
    expect(resolved.dreamRun).toBe(run);
  });

  it("leaves dreamRun undefined when the dream declares no run", async () => {
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({ dream: { instructions: "merge" } }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    expect(resolved.dreamRun).toBeUndefined();
  });

  it("throws a typed error when the module source is missing from the map", async () => {
    const moduleMap = buildModuleMap("agent/other.ts", { default: defineMemory({}) });

    await expect(resolveMemoryModule(REF, moduleMap, undefined)).rejects.toThrow(/memory/i);
  });
});
