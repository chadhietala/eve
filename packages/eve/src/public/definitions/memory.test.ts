import { describe, expect, it } from "vitest";

import {
  MEMORY_BRAND,
  defineMemory,
  isBrandedMemoryDefinition,
} from "#public/definitions/memory.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

describe("defineMemory", () => {
  it("preserves the authored stores and orientation", () => {
    const backend = new InMemoryMemoryStore();
    const memory = defineMemory({
      stores: { notes: { backend, access: "ro", path: "n" } },
      orientation: "# Orientation",
    });

    expect(memory.orientation).toBe("# Orientation");
    expect(memory.stores.notes.backend).toBe(backend);
    expect(memory.stores.notes.access).toBe("ro");
    expect(memory.stores.notes.path).toBe("n");
  });

  it("brands the returned definition", () => {
    const memory = defineMemory({ stores: { notes: { backend: new InMemoryMemoryStore() } } });

    expect((memory as object as Record<symbol, unknown>)[MEMORY_BRAND]).toBe(true);
    expect(isBrandedMemoryDefinition(memory)).toBe(true);
  });

  it("does not treat plain objects as branded", () => {
    expect(isBrandedMemoryDefinition({ stores: {} })).toBe(false);
    expect(isBrandedMemoryDefinition(null)).toBe(false);
  });

  it("retains the same object identity it was given", () => {
    const config = { stores: {}, orientation: "remember me" };
    const memory = defineMemory(config);

    expect(memory).toBe(config);
  });
});

// Type-only fixtures: these never run, but the compiler checks them.
function typeOnlyFixtures(): void {
  const memoryWithName = {
    stores: {},
    name: "scratchpad",
  };
  // @ts-expect-error Memory identity is path-derived.
  defineMemory(memoryWithName);

  const memoryWithRoot = {
    stores: {},
    root: "/memory",
  };
  // @ts-expect-error The mount root is fixed at /mnt/memory; not author-configurable.
  defineMemory(memoryWithRoot);
}

void typeOnlyFixtures;
