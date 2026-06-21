import { describe, expect, it } from "vitest";

import {
  MEMORY_BRAND,
  defineMemory,
  isBrandedMemoryDefinition,
} from "#public/definitions/memory.js";

describe("defineMemory", () => {
  it("preserves the authored config and infers literal types", () => {
    const memory = defineMemory({
      root: "/memory",
      orientation: "# Orientation",
    });

    expect(memory.root).toBe("/memory");
    expect(memory.orientation).toBe("# Orientation");
  });

  it("brands the returned definition", () => {
    const memory = defineMemory({ root: "/memory" });

    expect((memory as Record<symbol, unknown>)[MEMORY_BRAND]).toBe(true);
    expect(isBrandedMemoryDefinition(memory)).toBe(true);
  });

  it("does not treat plain objects as branded", () => {
    expect(isBrandedMemoryDefinition({ root: "/memory" })).toBe(false);
    expect(isBrandedMemoryDefinition(null)).toBe(false);
  });

  it("retains the same object identity it was given", () => {
    const config = { orientation: "remember me" };
    const memory = defineMemory(config);

    expect(memory).toBe(config);
  });
});

// Type-only fixtures: these never run, but the compiler checks them. Using
// `import type` for the sibling store keeps this test runnable before the
// `#runtime/memory/store` module exists.
function typeOnlyFixtures(): void {
  const memoryWithName = {
    root: "/memory",
    name: "scratchpad",
  };
  // @ts-expect-error Memory identity is path-derived.
  defineMemory(memoryWithName);

  const memoryWithHandler = {
    root: "/scratch",
    onRead: () => null,
  };
  // @ts-expect-error Per-op IO handlers were removed — memory is a filesystem.
  defineMemory(memoryWithHandler);
}

void typeOnlyFixtures;
