import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { buildMemoryOrientationMessages } from "#context/memory-orientation.js";
import { type MemoryConfig, type MountedStore, MemoryConfigKey } from "#runtime/memory/keys.js";
import { InMemoryMemoryStore } from "#runtime/memory/store.js";

const ROOT = "/mnt/memory";

function mountStore(name: string): MountedStore {
  return { name, backend: new InMemoryMemoryStore(), mountPath: `${ROOT}/${name}`, access: "rw" };
}

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    root: ROOT,
    stores: [mountStore("notes")],
    ...overrides,
  };
}

function messagesFor(config: MemoryConfig | undefined): string {
  const ctx = new ContextContainer();
  if (config !== undefined) {
    ctx.set(MemoryConfigKey, config);
  }
  const messages = buildMemoryOrientationMessages(ctx);
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

describe("buildMemoryOrientationMessages", () => {
  it("returns nothing when no memory is configured", () => {
    expect(buildMemoryOrientationMessages(new ContextContainer())).toEqual([]);
  });

  it("always points the model at the mount root", () => {
    expect(messagesFor(makeConfig())).toContain('mounted at "/mnt/memory"');
  });

  it("injects the author orientation when present", () => {
    const content = messagesFor(makeConfig({ orientation: "Keep an index.md updated." }));
    expect(content).toContain("Keep an index.md updated.");
  });

  it("injects the consolidated MEMORY.md index when present", () => {
    const content = messagesFor(makeConfig({ memoryIndex: "User prefers metric units." }));
    expect(content).toContain("Your consolidated memory");
    expect(content).toContain("User prefers metric units.");
  });

  it("omits the consolidated-memory block when there is no index yet", () => {
    expect(messagesFor(makeConfig())).not.toContain("Your consolidated memory");
  });

  it("injects both orientation and the consolidated index together", () => {
    const content = messagesFor(
      makeConfig({ orientation: "how to use memory", memoryIndex: "the facts" }),
    );
    expect(content).toContain("how to use memory");
    expect(content).toContain("the facts");
  });
});
