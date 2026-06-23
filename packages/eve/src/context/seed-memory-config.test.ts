import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { resolveMemoryModule } from "#context/seed-memory-config.js";
import { defineMemory } from "#public/definitions/memory.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

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
  it("threads each store's live backend keyed by store name", async () => {
    const notes = new InMemoryMemoryStore();
    const facts = new InMemoryMemoryStore();
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({
        stores: { notes: { backend: notes }, facts: { backend: facts } },
      }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    // The same live instances are threaded through — not copies.
    expect(resolved.backends.get("notes")).toBe(notes);
    expect(resolved.backends.get("facts")).toBe(facts);
    expect(resolved.dreamRun).toBeUndefined();
  });

  it("returns no backends and no dreamRun for an export with empty stores", async () => {
    const moduleMap = buildModuleMap(SOURCE_ID, { default: defineMemory({ stores: {} }) });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    expect(resolved.backends.size).toBe(0);
    expect(resolved.dreamRun).toBeUndefined();
  });

  it("threads the live dream.run override from a defineMemory export", async () => {
    const run = async (): Promise<void> => undefined;
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({ stores: {}, dream: { instructions: "merge", run } }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    // The live function is threaded through verbatim — not a copy.
    expect(resolved.dreamRun).toBe(run);
  });

  it("leaves dreamRun undefined when the dream declares no run", async () => {
    const moduleMap = buildModuleMap(SOURCE_ID, {
      default: defineMemory({ stores: {}, dream: { instructions: "merge" } }),
    });

    const resolved = await resolveMemoryModule(REF, moduleMap, undefined);

    expect(resolved.dreamRun).toBeUndefined();
  });

  it("throws a typed error when the module source is missing from the map", async () => {
    const moduleMap = buildModuleMap("agent/other.ts", { default: defineMemory({ stores: {} }) });

    await expect(resolveMemoryModule(REF, moduleMap, undefined)).rejects.toThrow(/memory/i);
  });
});
