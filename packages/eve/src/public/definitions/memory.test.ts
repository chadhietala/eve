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

  defineMemory({
    root: "/scratch",
    async onRead(path, ctx) {
      void ctx.session.id;
      return path === "missing" ? null : new Uint8Array();
    },
    async onWrite(path, bytes, ctx) {
      void path;
      void bytes;
      void ctx.channel.continuationToken;
    },
    async onList(prefix, ctx) {
      void prefix;
      void ctx.messages;
      return [{ path: "a.md", size: 1 }];
    },
    async onGrep(pattern, prefix, ctx) {
      void pattern;
      void prefix;
      void ctx.session.auth;
      return [{ path: "a.md", line: 1, text: "match" }];
    },
  });
}

void typeOnlyFixtures;
